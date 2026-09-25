/**
 * Run history: one directory of append-only JSON lines per run.
 *
 *   <root>/runs/<run-id>/run.json      the run header
 *   <root>/runs/<run-id>/events.jsonl  one event per line, in order
 *   <root>/runs/<run-id>/hosts.jsonl   one host result per line
 *
 * Parallel runs write to different directories, so there is no shared writer.
 * An event's id is its line number, so a separate `nat watch` process derives
 * the same ids without coordination, and a partially written trailing line is
 * ignored until its newline lands.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Json, jarr, jobj, jstr, parseJson, renderJson, renderJsonPretty } from "./json.ts";
import { CommandResult, HostRunResult, RunRecord, SessionEvent } from "./models.ts";

export const STATUS_RUNNING = "running";
export const STATUS_COMPLETED = "completed";
export const STATUS_COMPLETED_WITH_ERRORS = "completed_with_errors";

/** Run ids become directory names; separators and dot segments are never valid. */
export function isSafeRunId(runId: string): boolean {
  return runId !== "" && /^[A-Za-z0-9_-]+$/.test(runId);
}

function nowIso(): string {
  return new Date().toISOString();
}

/** ISO timestamp → `YYYY-MM-DD HH:MM:SS`, the form the listings print. */
export function formatTimestamp(iso: string): string {
  if (iso === "") return iso;
  return iso.replace(/T/, " ").replace(/\.\d+Z?$/, "").replace(/Z$/, "");
}

/** An event's JSON form; `withIdentity` adds `id`/`runId` for `nat watch --json`. */
export function eventToJson(event: SessionEvent, withIdentity: boolean): Json {
  const node = jobj();
  if (withIdentity) {
    node.setNum("id", event.id);
    node.setStr("runId", event.runId);
  }
  node.setStr("hostAlias", event.hostAlias);
  node.setStr("eventType", event.eventType);
  node.setStr("message", event.message);
  node.setNumOrNull("commandIndex", event.commandIndex < 0 ? null : event.commandIndex);
  node.setStrOrNull("commandText", event.commandText === "" ? null : event.commandText);
  if (event.parsed !== null) node.set("parsed", event.parsed);
  node.setStr("createdAt", event.createdAt);
  return node;
}

export function eventFromJson(node: Json, runId: string, id: number): SessionEvent {
  const event = new SessionEvent(runId, node.str("hostAlias", ""), node.str("eventType", ""), node.str("message", ""));
  event.id = id;
  const index = node.get("commandIndex");
  event.commandIndex = index === null || index.isNull() ? -1 : node.num("commandIndex", -1);
  const text = node.get("commandText");
  event.commandText = text === null || text.isNull() ? "" : node.str("commandText", "");
  event.parsed = node.get("parsed");
  event.createdAt = node.str("createdAt", "");
  return event;
}

export function commandResultToJson(entry: CommandResult): Json {
  const node = jobj();
  node.setStr("command", entry.command);
  node.setStr("output", entry.output);
  if (entry.parsed !== null) node.set("parsed", entry.parsed);
  return node;
}

export function hostResultToJson(result: HostRunResult): Json {
  const node = jobj();
  node.setStr("hostAlias", result.hostAlias);
  node.setStr("hostname", result.hostname);
  node.setBool("success", result.success);
  node.setStrOrNull("platform", result.platform === "" ? null : result.platform);
  node.setStrOrNull("error", result.error === "" ? null : result.error);
  const commands = jarr();
  for (const entry of result.commands) commands.push(commandResultToJson(entry));
  node.set("commands", commands);
  node.setOptStr("createdAt", result.createdAt);
  return node;
}

export function hostResultFromJson(node: Json): HostRunResult {
  const result = new HostRunResult(node.str("hostAlias", ""), node.str("hostname", ""));
  result.success = node.bool("success", false);
  const platform = node.get("platform");
  result.platform = platform === null || platform.isNull() ? "" : node.str("platform", "");
  const error = node.get("error");
  result.error = error === null || error.isNull() ? "" : node.str("error", "");
  result.createdAt = node.str("createdAt", "");
  const commands = node.get("commands");
  if (commands !== null && commands.kind === "arr") {
    for (const item of commands.items) {
      const entry = new CommandResult(item.str("command", ""), item.str("output", ""));
      entry.parsed = item.get("parsed");
      result.commands.push(entry);
    }
  }
  return result;
}

/** The in-memory mirror of the run this process owns. */
class RunState {
  record: RunRecord;
  events: SessionEvent[];
  results: HostRunResult[];

  constructor(record: RunRecord) {
    this.record = record;
    this.events = [];
    this.results = [];
  }
}

export class RunStore {
  /** The `runs/` directory, or "" when this store is memory-only. */
  runsDir: string;
  private memory: Map<string, RunState>;

  constructor(runsDir: string) {
    this.runsDir = runsDir;
    this.memory = new Map<string, RunState>();
    if (runsDir !== "") mkdirSync(runsDir, { recursive: true, mode: 0o700 });
  }

  /** A store that keeps nothing on disk (`--no-store`). */
  static inMemory(): RunStore {
    return new RunStore("");
  }

  private dirFor(runId: string): string {
    return join(this.runsDir, runId);
  }

  private state(runId: string): RunState | null {
    const existing = this.memory.get(runId);
    return existing === undefined ? null : existing;
  }

  createRun(runId: string, commandName: string, args: Json): void {
    if (!isSafeRunId(runId)) throw new Error("invalid run-id");
    const record = new RunRecord(runId, commandName, nowIso(), STATUS_RUNNING);
    record.args = args;
    record.ownerPid = process.pid;
    this.memory.set(runId, new RunState(record));
    if (this.runsDir === "") return;
    const dir = this.dirFor(runId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "events.jsonl"), "", { mode: 0o600 });
    writeFileSync(join(dir, "hosts.jsonl"), "", { mode: 0o600 });
    this.writeRecord(record);
  }

  private writeRecord(record: RunRecord): void {
    if (this.runsDir === "") return;
    const node = jobj();
    node.setStr("runId", record.runId);
    node.setStr("commandName", record.commandName);
    node.setStr("createdAt", record.createdAt);
    node.setStr("status", record.status);
    node.setNum("ownerPid", record.ownerPid);
    node.set("args", record.args);
    const dir = this.dirFor(record.runId);
    const target = join(dir, "run.json");
    const pending = join(dir, `run.${process.pid}.tmp`);
    writeFileSync(pending, renderJsonPretty(node, 2) + "\n", { mode: 0o600 });
    renameSync(pending, target);
  }

  setRunStatus(runId: string, status: string): void {
    if (!isSafeRunId(runId)) return;
    const state = this.state(runId);
    if (state !== null) {
      state.record.status = status;
      this.writeRecord(state.record);
      return;
    }
    const record = this.getRun(runId);
    if (record === null) return;
    record.status = status;
    this.writeRecord(record);
  }

  /** Append one event. Returns the id it was given (its line number). */
  appendEvent(event: SessionEvent): number {
    if (!isSafeRunId(event.runId)) return 0;
    event.createdAt = nowIso();
    const state = this.state(event.runId);
    const id = state === null ? 0 : state.events.length + 1;
    event.id = id;
    if (state !== null) state.events.push(event);
    if (this.runsDir !== "") {
      appendFileSync(join(this.dirFor(event.runId), "events.jsonl"), renderJson(eventToJson(event, false)) + "\n");
    }
    return id;
  }

  saveHostResult(runId: string, result: HostRunResult): void {
    if (!isSafeRunId(runId)) return;
    const state = this.state(runId);
    if (state !== null) state.results.push(result);
    if (this.runsDir === "") return;
    const node = hostResultToJson(result);
    node.setStr("createdAt", nowIso());
    appendFileSync(join(this.dirFor(runId), "hosts.jsonl"), renderJson(node) + "\n");
  }

  /** Read a run's header, from memory when this process owns it. */
  getRun(runId: string): RunRecord | null {
    if (!isSafeRunId(runId)) return null;
    const state = this.state(runId);
    if (state !== null) return state.record;
    if (this.runsDir === "") return null;
    const path = join(this.dirFor(runId), "run.json");
    if (!existsSync(path)) return null;
    try {
      const node = parseJson(readFileSync(path, "utf8"));
      const record = new RunRecord(
        node.str("runId", runId),
        node.str("commandName", ""),
        node.str("createdAt", ""),
        node.str("status", ""),
      );
      const args = node.get("args");
      if (args !== null) record.args = args;
      record.ownerPid = node.num("ownerPid", -1);
      return record;
    } catch (err) {
      return null;
    }
  }

  /** Complete JSON lines from a file; a partial trailing line is skipped. */
  private readLines(path: string): Json[] {
    if (!existsSync(path)) return [];
    let text = "";
    try {
      text = readFileSync(path, "utf8");
    } catch (err) {
      return [];
    }
    const nodes: Json[] = [];
    const lastNewline = text.lastIndexOf("\n");
    if (lastNewline < 0) return nodes;
    for (const line of text.slice(0, lastNewline).split("\n")) {
      if (line.trim() === "") continue;
      try {
        nodes.push(parseJson(line));
      } catch (err) {
        // A torn line from a concurrent writer; the next read picks it up.
      }
    }
    return nodes;
  }

  /** Events after `afterId`, in order. */
  iterEvents(runId: string, afterId: number): SessionEvent[] {
    if (!isSafeRunId(runId)) return [];
    const state = this.state(runId);
    if (state !== null) {
      const out: SessionEvent[] = [];
      for (const event of state.events) {
        if (event.id > afterId) out.push(event);
      }
      return out;
    }
    if (this.runsDir === "") return [];
    const out: SessionEvent[] = [];
    const nodes = this.readLines(join(this.dirFor(runId), "events.jsonl"));
    for (let i = 0; i < nodes.length; i += 1) {
      const id = i + 1;
      if (id <= afterId) continue;
      out.push(eventFromJson(nodes[i], runId, id));
    }
    return out;
  }

  /** Stored host results for a run, in completion order. */
  getResults(runId: string): HostRunResult[] {
    if (!isSafeRunId(runId)) return [];
    const state = this.state(runId);
    if (state !== null) return state.results;
    if (this.runsDir === "") return [];
    const out: HostRunResult[] = [];
    for (const node of this.readLines(join(this.dirFor(runId), "hosts.jsonl"))) {
      out.push(hostResultFromJson(node));
    }
    return out;
  }

  /** Run headers on disk, newest first. */
  private allRecords(): RunRecord[] {
    if (this.runsDir === "" || !existsSync(this.runsDir)) return [];
    const records: RunRecord[] = [];
    for (const name of readdirSync(this.runsDir)) {
      const record = this.getRun(name);
      if (record !== null) records.push(record);
    }
    records.sort((a: RunRecord, b: RunRecord) => {
      if (a.createdAt === b.createdAt) return a.runId < b.runId ? 1 : -1;
      return a.createdAt < b.createdAt ? 1 : -1;
    });
    return records;
  }

  listRuns(limit: number): RunRecord[] {
    const records = this.allRecords();
    return limit < 0 ? records : records.slice(0, limit);
  }

  listRunsForHost(hostAlias: string, limit: number): RunRecord[] {
    const out: RunRecord[] = [];
    for (const record of this.allRecords()) {
      if (limit >= 0 && out.length >= limit) break;
      let seen = false;
      for (const node of this.readLines(join(this.dirFor(record.runId), "hosts.jsonl"))) {
        if (node.str("hostAlias", "") === hostAlias) {
          seen = true;
          break;
        }
      }
      if (seen) out.push(record);
    }
    return out;
  }

  /**
   * Mark a run complete when results exist but the header still says running —
   * the state a run left behind if its process was killed mid-flight.
   */
  finalizeRunIfResultsExist(runId: string): void {
    const record = this.getRun(runId);
    if (record === null || record.status !== STATUS_RUNNING) return;
    if (this.runsDir === "") return;

    const results = this.readLines(join(this.dirFor(runId), "hosts.jsonl"));
    const hosts = record.args.get("hosts");
    const expected = hosts !== null && hosts.kind === "arr" ? hosts.items.length : -1;
    const complete = expected >= 0 && results.length >= expected;
    let hasFailure = false;
    for (const result of results) {
      if (!result.bool("success", false)) hasFailure = true;
    }

    // A full host set is definitive even in the tiny window before the owner
    // rewrites run.json: every host emits its final event before its result.
    if (complete) {
      this.setRunStatus(runId, hasFailure ? STATUS_COMPLETED_WITH_ERRORS : STATUS_COMPLETED);
      return;
    }

    // `nat watch <id>` may attach while the run is live: a partial run is only
    // terminal once its owning process is gone. (pid <= 0 would address a
    // process group, not the owner.)
    if (record.ownerPid > 0) {
      try {
        process.kill(record.ownerPid, 0);
        return;
      } catch (err) {
        // ESRCH: the owner died, so the partial (even empty) run is terminal.
      }
    }
    this.setRunStatus(runId, STATUS_COMPLETED_WITH_ERRORS);
  }
}

/** The `args` blob recorded with a run, for `nat runs` context. */
export function runArgs(hosts: string[], commands: string[], options: Json): Json {
  const node = jobj();
  const hostList = jarr();
  for (const host of hosts) hostList.push(jstr(host));
  node.set("hosts", hostList);
  const commandList = jarr();
  for (const command of commands) commandList.push(jstr(command));
  node.set("commands", commandList);
  node.set("options", options);
  return node;
}
