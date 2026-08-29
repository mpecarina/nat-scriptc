import { strict as assert } from "node:assert";
import { appendFileSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { jobj, jstr, renderJson } from "../src/json.ts";
import { CommandResult, HostRunResult, SessionEvent } from "../src/models.ts";
import {
  RunStore,
  STATUS_COMPLETED,
  STATUS_COMPLETED_WITH_ERRORS,
  STATUS_RUNNING,
  formatTimestamp,
  runArgs,
} from "../src/store.ts";

function scratchStore(): RunStore {
  return new RunStore(join(mkdtempSync(join(tmpdir(), "nat-store-")), "runs"));
}

function sampleResult(alias: string, success: boolean): HostRunResult {
  const result = new HostRunResult(alias, `10.0.0.${alias.length}`);
  result.success = success;
  const entry = new CommandResult("show version", "Version 1.2.3");
  entry.parsed = jobj().setStr("kind", "demo");
  result.commands.push(entry);
  if (!success) result.error = "boom";
  return result;
}

describe("formatTimestamp", () => {
  test("renders an ISO stamp as the listing form", () => {
    assert.equal(formatTimestamp("2026-08-28T20:15:04.123Z"), "2026-08-28 20:15:04");
    assert.equal(formatTimestamp(""), "");
  });
});

describe("RunStore", () => {
  test("round-trips a run through the filesystem", () => {
    const store = scratchStore();
    store.createRun("run1", "run", runArgs(["leaf1"], ["show version"], jobj().setBool("parse", true)));
    store.appendEvent(new SessionEvent("run1", "leaf1", "host_start", "connecting"));
    store.saveHostResult("run1", sampleResult("leaf1", true));
    store.setRunStatus("run1", STATUS_COMPLETED);

    // A separate store instance reads the same run back off disk.
    const reader = new RunStore(store.runsDir);
    const record = reader.getRun("run1");
    assert.ok(record !== null);
    assert.equal(record.status, STATUS_COMPLETED);
    assert.equal(record.commandName, "run");

    const events = reader.iterEvents("run1", 0);
    assert.equal(events.length, 1);
    assert.equal(events[0].id, 1);
    assert.equal(events[0].eventType, "host_start");

    const results = reader.getResults("run1");
    assert.equal(results.length, 1);
    assert.equal(results[0].hostAlias, "leaf1");
    assert.equal(results[0].success, true);
    assert.equal(results[0].commands[0].output, "Version 1.2.3");
    assert.match(results[0].createdAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(results[0].commands[0].parsed !== null);
    assert.equal(renderJson(results[0].commands[0].parsed), '{"kind":"demo"}');
  });

  test("run ids cannot escape the history directory", () => {
    const store = scratchStore();
    assert.throws(() => store.createRun("../escape", "run", jobj()), /invalid run-id/);
    assert.equal(store.getRun("../escape"), null);
    assert.deepEqual(store.iterEvents("../escape", 0), []);
    assert.deepEqual(store.getResults("../escape"), []);
  });

  test("new history directories and files are private", () => {
    const store = scratchStore();
    store.createRun("run1", "run", jobj());
    const dir = join(store.runsDir, "run1");
    assert.equal(statSync(store.runsDir).mode & 0o777, 0o700);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(join(dir, "run.json")).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, "events.jsonl")).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, "hosts.jsonl")).mode & 0o777, 0o600);
  });

  test("event ids are line numbers, so a reader agrees with the writer", () => {
    const store = scratchStore();
    store.createRun("run1", "run", jobj());
    for (let i = 0; i < 3; i += 1) {
      assert.equal(store.appendEvent(new SessionEvent("run1", "leaf1", "command_output", `${i}`)), i + 1);
    }
    const reader = new RunStore(store.runsDir);
    assert.deepEqual(
      reader.iterEvents("run1", 1).map((e) => e.id),
      [2, 3],
    );
  });

  test("a torn trailing line is ignored until its newline lands", () => {
    const store = scratchStore();
    store.createRun("run1", "run", jobj());
    store.appendEvent(new SessionEvent("run1", "leaf1", "host_start", "connecting"));
    const path = join(store.runsDir, "run1", "events.jsonl");
    appendFileSync(path, '{"hostAlias":"leaf1","eventType":"command_out');

    const reader = new RunStore(store.runsDir);
    assert.equal(reader.iterEvents("run1", 0).length, 1);

    appendFileSync(path, 'put","message":"done","createdAt":""}\n');
    assert.equal(new RunStore(store.runsDir).iterEvents("run1", 0).length, 2);
  });

  test("lists runs newest first and filters by host", () => {
    const store = scratchStore();
    store.createRun("older", "run", jobj());
    store.saveHostResult("older", sampleResult("leaf1", true));
    store.createRun("newer", "run", jobj());
    store.saveHostResult("newer", sampleResult("web1", true));

    const reader = new RunStore(store.runsDir);
    const all = reader.listRuns(50);
    assert.equal(all.length, 2);
    assert.deepEqual(
      reader.listRunsForHost("web1", 50).map((r) => r.runId),
      ["newer"],
    );
    assert.deepEqual(reader.listRunsForHost("nobody", 50), []);
    assert.equal(reader.listRuns(-1).length, 2, "SQLite-style LIMIT -1 means no limit");
    assert.equal(reader.listRunsForHost("web1", -1).length, 1);
  });

  test("a watcher does not finalize a run whose owner is still alive", () => {
    const store = scratchStore();
    store.createRun("run1", "run", jobj());
    store.saveHostResult("run1", sampleResult("leaf1", true));

    const reader = new RunStore(store.runsDir);
    reader.finalizeRunIfResultsExist("run1");
    const record = reader.getRun("run1");
    assert.ok(record !== null);
    assert.equal(record.status, STATUS_RUNNING);
  });

  test("a complete host set is enough to close the status-write race", () => {
    const store = scratchStore();
    store.createRun("run1", "run", runArgs(["leaf1"], ["show version"], jobj()));
    store.saveHostResult("run1", sampleResult("leaf1", true));
    store.finalizeRunIfResultsExist("run1");
    const record = store.getRun("run1");
    assert.ok(record !== null);
    assert.equal(record.status, STATUS_COMPLETED);
  });

  test("finalize closes a partial run whose process died mid-flight", () => {
    const store = scratchStore();
    store.createRun("run1", "run", runArgs(["leaf1", "leaf2"], ["show version"], jobj()));
    store.saveHostResult("run1", sampleResult("leaf1", true));

    // Simulate a stale header from a process that no longer exists.
    const headerPath = join(store.runsDir, "run1", "run.json");
    const header = JSON.parse(readFileSync(headerPath, "utf8"));
    header.ownerPid = 99999999;
    writeFileSync(headerPath, JSON.stringify(header));

    const reader = new RunStore(store.runsDir);
    const before = reader.getRun("run1");
    assert.ok(before !== null);
    assert.equal(before.status, STATUS_RUNNING);
    reader.finalizeRunIfResultsExist("run1");
    const after = new RunStore(store.runsDir).getRun("run1");
    assert.ok(after !== null);
    assert.equal(after.status, STATUS_COMPLETED_WITH_ERRORS);
  });

  test("the in-memory store keeps nothing on disk", () => {
    const store = RunStore.inMemory();
    store.createRun("run1", "run", jobj());
    store.appendEvent(new SessionEvent("run1", "leaf1", "host_start", "connecting"));
    store.saveHostResult("run1", sampleResult("leaf1", true));
    assert.equal(store.runsDir, "");
    assert.equal(store.iterEvents("run1", 0).length, 1);
    assert.equal(store.getResults("run1").length, 1);
    assert.deepEqual(store.listRuns(10), []);
  });

  test("each run owns its own directory, so parallel runs never contend", () => {
    const store = scratchStore();
    const other = new RunStore(store.runsDir);
    store.createRun("a", "run", jobj());
    other.createRun("b", "run", jobj());
    store.appendEvent(new SessionEvent("a", "leaf1", "host_start", "a1"));
    other.appendEvent(new SessionEvent("b", "leaf2", "host_start", "b1"));

    const reader = new RunStore(store.runsDir);
    assert.equal(reader.iterEvents("a", 0)[0].message, "a1");
    assert.equal(reader.iterEvents("b", 0)[0].message, "b1");
  });

  test("the run header records the arguments verbatim", () => {
    const store = scratchStore();
    store.createRun("run1", "run", runArgs(["leaf1"], ["show version"], jobj().set("driver", jstr("sonic"))));
    const text = readFileSync(join(store.runsDir, "run1", "run.json"), "utf8");
    const parsed = JSON.parse(text);
    assert.deepEqual(parsed.args.hosts, ["leaf1"]);
    assert.deepEqual(parsed.args.commands, ["show version"]);
    assert.equal(parsed.args.options.driver, "sonic");
  });
});
