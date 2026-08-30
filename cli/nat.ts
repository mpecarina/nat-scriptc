/**
 * cli/nat.ts — the command-line entry point.
 *
 *   inventory list                 List host aliases from the ssh config
 *   inventory show <host>          Show resolved connection details
 *   run <host...>                  Run commands across hosts
 *   parse                          Run the parser chain on saved output
 *   watch <run-id>                 Replay/stream a run's events
 *   results <run-id>               Print stored command output for a run
 *   runs [--host <alias>]          List recent runs
 *   cred set|get|delete <host>     Manage a secret in the OS keychain
 *   doctor                         Report the environment nat will use
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { createInterface } from "node:readline";

import {
  ArgError,
  OptionSpec,
  ParsedArgs,
  booleanOption,
  parseArgs,
  repeatedOption,
  splitAtSeparator,
  stringOption,
  wantsHelp,
} from "../src/args.ts";
import { parseCommandSpec, readCommandText } from "../src/command-files.ts";
import {
  CredentialError,
  BACKEND_FILE,
  backendDescription,
  credentialBackend,
  deleteSecret,
  getSecret,
  normalizeKind,
  setSecret,
} from "../src/credentials.ts";
import { DEFAULT_DRIVER, ParserTable, parseOutput } from "../src/drivers.ts";
import { Inventory, InventoryError, isHostPattern, loadInventory, loadJsonInventory, resolveHost, selectHosts, suggestAliases } from "../src/inventory.ts";
import { Json, jarr, jobj, renderJson, renderJsonPretty } from "../src/json.ts";
import { CommandSpec, HostRunResult, ParserContext, SessionEvent } from "../src/models.ts";
import { ParserPackError, commandParserTable, loadParserPacks } from "../src/parser-packs.ts";
import { defaultSshConfigPath, resolveRunPaths } from "../src/paths.ts";
import { commandExists, probeCommand, sleep } from "../src/process.ts";
import {
  RunOptions,
  runMany,
  runOptionsJson,
} from "../src/runner.ts";
import { configuredIgnoreUnknownPatterns, listHostAliases } from "../src/sshconfig.ts";
import {
  RunStore,
  STATUS_COMPLETED,
  STATUS_COMPLETED_WITH_ERRORS,
  formatTimestamp,
  hostResultToJson,
  runArgs,
} from "../src/store.ts";
import { indentLines } from "../src/text.ts";
import { ConnectionError, TransportOptions, TransportWorkspace, resolveEffectiveHost } from "../src/transport.ts";
import {
  HELP_CRED,
  HELP_DOCTOR,
  HELP_INVENTORY,
  HELP_PARSE,
  HELP_RESULTS,
  HELP_RUN,
  HELP_RUNS,
  HELP_WATCH,
  USAGE,
  VERSION,
} from "../src/usage.ts";

function fail(message: string): number {
  process.stderr.write(`nat: ${message}\n`);
  return 1;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "unknown error";
}

/** Read all of stdin as text. */
function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch (err) {
    return "";
  }
}

/**
 * Prompt for a secret without echoing it. `stty` turns the echo off on a real
 * terminal; a piped stdin just reads the line. The prompt goes to stderr so it
 * never lands in `--json` output.
 */
async function promptSecret(message: string): Promise<string> {
  process.stderr.write(message);
  const interactive = process.stdin.isTTY;
  let echoDisabled = false;

  const restoreEcho = (): void => {
    if (!echoDisabled) return;
    try {
      execFileSync("stty", ["echo"], { stdio: ["inherit", "inherit", "inherit"] });
    } catch (err) {
      // Best effort: a terminal may have disappeared while the prompt was open.
    }
    echoDisabled = false;
  };
  const interrupt = (): void => {
    restoreEcho();
    process.stderr.write("\n");
    process.exit(130);
  };
  const terminate = (): void => {
    restoreEcho();
    process.stderr.write("\n");
    process.exit(143);
  };

  if (interactive) {
    try {
      execFileSync("stty", ["-echo"], { stdio: ["inherit", "inherit", "inherit"] });
      echoDisabled = true;
      process.once("SIGINT", interrupt);
      process.once("SIGTERM", terminate);
    } catch (err) {
      // No stty (or no terminal): the prompt still works, it just echoes.
    }
  }

  try {
    const rl = createInterface({ input: process.stdin });
    return await new Promise((resolve) => {
      rl.question("", (value: string) => {
        rl.close();
        resolve(value);
      });
    });
  } finally {
    if (echoDisabled) {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
    }
    restoreEcho();
    process.stderr.write("\n");
  }
}

/** Pull a global `--ssh-config` out of the args, wherever it appears. */
class GlobalArgs {
  sshConfig: string;
  rest: string[];

  constructor(sshConfig: string, rest: string[]) {
    this.sshConfig = sshConfig;
    this.rest = rest;
  }
}

function extractSshConfig(args: string[]): GlobalArgs {
  const rest: string[] = [];
  let sshConfig = "";
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--") {
      for (let j = i; j < args.length; j += 1) rest.push(args[j]);
      break;
    }
    if (arg === "--ssh-config") {
      if (i + 1 >= args.length) throw new ArgError("option --ssh-config requires a value");
      sshConfig = args[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith("--ssh-config=")) {
      sshConfig = arg.slice("--ssh-config=".length);
      continue;
    }
    rest.push(arg);
  }
  return new GlobalArgs(sshConfig, rest);
}

/* ------------------------------- inventory ------------------------------- */

function cmdInventory(args: string[], sshConfig: string): number {
  if (wantsHelp(args)) {
    process.stdout.write(HELP_INVENTORY + "\n");
    return 0;
  }
  const sub = args.length > 0 ? args[0] : "";

  if (sub === "list") {
    const inventory = loadInventory(sshConfig);
    const aliases = listHostAliases(inventory.config);
    if (aliases.length === 0) {
      process.stdout.write("(no hosts found)\n");
      return 0;
    }
    for (const alias of aliases) process.stdout.write(alias + "\n");
    return 0;
  }

  if (sub === "show") {
    if (args.length < 2 || args[1] === "") return fail("inventory show requires a host alias");
    const inventory = loadInventory(sshConfig);
    const host = resolveInventoryHostWithSsh(inventory, args[1], sshConfig);
    process.stdout.write(`alias:        ${host.alias}\n`);
    process.stdout.write(`hostname:     ${host.hostname}\n`);
    process.stdout.write(`user:         ${host.user === "" ? "(default)" : host.user}\n`);
    process.stdout.write(`port:         ${host.port}\n`);
    process.stdout.write(
      `identityfile: ${host.identityFiles.length > 0 ? host.identityFiles.join(", ") : "(none)"}\n`,
    );
    process.stdout.write(`proxyjump:    ${host.proxyJump === "" ? "(none)" : host.proxyJump}\n`);
    return 0;
  }

  return fail("inventory expects `list` or `show <host>`");
}

/* ------------------------------ rendering -------------------------------- */

function printEvent(event: SessionEvent): void {
  const prefix = `[${formatTimestamp(event.createdAt)}] ${event.hostAlias} ${event.eventType}`;
  if (event.eventType !== "command_output") {
    process.stdout.write(`${prefix}: ${event.message}\n`);
    return;
  }
  // Printed verbatim: the runner already applied cleanup (or skipped it for --raw).
  process.stdout.write(`${prefix}:\n`);
  if (event.message !== "") process.stdout.write(event.message + "\n");
  if (event.parsed !== null) {
    process.stdout.write("parsed:\n");
    process.stdout.write(indentLines(renderJsonPretty(event.parsed, 2), 2) + "\n");
  }
}

/**
 * Render finished results as text: a `=== host ===` header, then `$ cmd` and
 * its output per command. Shared by `run` and `results` so both read the same.
 *
 * `output` prints verbatim. The runner already applied echo/prompt cleanup
 * where it applies (and honours `--raw` by skipping it), and only the runner
 * knows whether an interactive session was used — re-stripping here would eat
 * any line containing the command text.
 */
function renderResults(results: HostRunResult[]): void {
  for (const result of results) {
    const status = result.success ? "ok" : "error";
    process.stdout.write(`=== ${result.hostAlias} (${result.hostname}) [${status}] ===\n`);
    if (result.error !== "") process.stdout.write(`error: ${result.error}\n`);
    for (const entry of result.commands) {
      process.stdout.write(`$ ${entry.command}\n`);
      if (entry.output !== "") process.stdout.write(entry.output + "\n");
      if (entry.parsed !== null) {
        process.stdout.write("parsed:\n");
        process.stdout.write(indentLines(renderJsonPretty(entry.parsed, 2), 2) + "\n");
      }
      process.stdout.write("\n");
    }
  }
}

function resultsEnvelope(runId: string, results: HostRunResult[]): Json {
  const node = jobj();
  node.setStr("runId", runId);
  const list = jarr();
  for (const result of results) list.push(hostResultToJson(result));
  node.set("results", list);
  return node;
}

/* ------------------------------ ssh transport ----------------------------- */

/**
 * Decide which config file ssh should read. A JSON inventory has no file, so it
 * gets a private config inside the workspace. Real configs remain in place:
 * the transport's narrowly scoped IgnoreUnknown option lets OpenSSH skip the
 * legacy nat driver keywords without flattening away Include/Match semantics.
 */
function prepareSshConfigFile(
  inventory: Inventory,
  workspace: TransportWorkspace,
  explicitPath: string,
  transport: TransportOptions,
): string {
  if (inventory.config.hasBareNatKeywords) {
    const ignored = ["Driver", "NatOs", "Nat-Driver", "Nat-Os"];
    for (const pattern of configuredIgnoreUnknownPatterns(inventory.config)) {
      if (!ignored.includes(pattern)) ignored.push(pattern);
    }
    transport.ignoreUnknown = ignored.join(",");
  }
  if (inventory.syntheticText !== "") {
    const path = workspace.reserve(".ssh_config");
    writeFileSync(path, inventory.syntheticText);
    return path;
  }
  return explicitPath === "" ? "" : inventory.path;
}

/** Resolve one inventory host through the same OpenSSH config used to connect. */
function resolveInventoryHostWithSsh(inventory: Inventory, alias: string, explicitPath: string) {
  const workspace = new TransportWorkspace();
  try {
    const transport = new TransportOptions();
    transport.configPath = prepareSshConfigFile(inventory, workspace, explicitPath, transport);
    return resolveEffectiveHost(transport, resolveHost(inventory.config, alias), "", -1, "");
  } finally {
    workspace.dispose();
  }
}

/* ---------------------------------- run ---------------------------------- */

function runOptionSpecs(): OptionSpec[] {
  return [
    repeatedOption("command", "c"),
    stringOption("file", "f"),
    booleanOption("all", ""),
    booleanOption("ask-pass", ""),
    stringOption("jump", ""),
    booleanOption("jump-shell", ""),
    booleanOption("enter-sonic-cli", ""),
    booleanOption("no-sonic-cli", ""),
    booleanOption("no-ios-shell", ""),
    stringOption("inventory", ""),
    stringOption("connect-timeout", ""),
    stringOption("command-timeout", ""),
    stringOption("workers", ""),
    booleanOption("watch", ""),
    booleanOption("parse", ""),
    repeatedOption("parsers", ""),
    stringOption("parser-cmd", ""),
    stringOption("driver", ""),
    stringOption("user", "u"),
    booleanOption("json", ""),
    booleanOption("raw", ""),
    booleanOption("quiet", "q"),
    booleanOption("no-store", ""),
    stringOption("ssh-bin", ""),
    booleanOption("no-multiplex", ""),
    stringOption("host-key-checking", ""),
    repeatedOption("ssh-option", ""),
    booleanOption("verbose", "V"),
  ];
}

function buildTransportOptions(parsed: ParsedArgs): TransportOptions {
  const transport = new TransportOptions();
  const bin = parsed.str("ssh-bin", "");
  if (bin !== "") transport.sshBin = bin;
  transport.connectTimeout = parsed.int("connect-timeout", 20);
  transport.multiplex = !parsed.bool("no-multiplex");
  const checking = parsed.str("host-key-checking", "");
  if (checking !== "") transport.hostKeyChecking = checking;
  for (const option of parsed.list("ssh-option")) transport.extraOptions.push(option);
  transport.verbose = parsed.bool("verbose");
  return transport;
}

/** Load `--parsers` packs and/or the `--parser-cmd` filter into one table. */
function buildParserTable(parsed: ParsedArgs): ParserTable | null {
  const sources = parsed.list("parsers");
  const program = parsed.str("parser-cmd", "");
  if (sources.length === 0 && program === "") return null;
  const table = new ParserTable();
  if (program !== "") table.merge(commandParserTable(program, []));
  if (sources.length > 0) table.merge(loadParserPacks(sources));
  return table;
}

/** Stream a run's events to stdout while it is still going. */
async function streamRunEvents(store: RunStore, runId: string, done: Promise<HostRunResult[]>): Promise<void> {
  let lastId = 0;
  let finished = false;
  const watcher = done
    .then(() => {
      finished = true;
    })
    .catch(() => {
      finished = true;
    });
  while (!finished) {
    const rows = store.iterEvents(runId, lastId);
    if (rows.length > 0) {
      for (const row of rows) {
        lastId = row.id;
        printEvent(row);
      }
      continue;
    }
    await sleep(200);
  }
  await watcher;
  for (const row of store.iterEvents(runId, lastId)) {
    lastId = row.id;
    printEvent(row);
  }
}

async function cmdRun(args: string[], sshConfig: string): Promise<number> {
  const split = splitAtSeparator(args);
  if (wantsHelp(split.head)) {
    process.stdout.write(HELP_RUN + "\n");
    return 0;
  }

  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(split.head, runOptionSpecs(), true);
  } catch (err) {
    return fail(errorMessage(err));
  }

  const requested = parsed.positionals;
  const includeAll = parsed.bool("all");
  if (requested.length === 0 && !includeAll) {
    return fail("run requires at least one host (or --all)");
  }

  // The host inventory: a JSON lab inventory, or the ssh config.
  let inventory: Inventory;
  const inventoryPath = parsed.str("inventory", "");
  try {
    inventory = inventoryPath !== "" ? loadJsonInventory(inventoryPath) : loadInventory(sshConfig);
  } catch (err) {
    return fail(errorMessage(err));
  }
  if (inventoryPath !== "") {
    for (const skipped of inventory.skipped) {
      process.stderr.write(`nat: inventory skipped '${skipped.id}': ${skipped.reason}\n`);
    }
    if (inventory.deviceCount === 0) {
      return fail(`inventory '${inventory.path}' has no usable hosts (need id + management IP)`);
    }
  }

  const selection = selectHosts(inventory.config, requested, includeAll);
  if (selection.unmatched.length > 0) {
    return fail(`no hosts in the ssh config match: ${selection.unmatched.join(", ")}`);
  }
  const hosts = selection.hosts;
  if (hosts.length === 0) return fail("run requires at least one host (or --all)");

  // A non-blocking "did you mean" for literal hosts that are not known aliases,
  // kept soft so IPs, FQDNs and DNS-resolvable names still work.
  for (const token of requested) {
    if (isHostPattern(token)) continue;
    const hints = suggestAliases(inventory.config, token);
    if (hints.length > 0) {
      process.stderr.write(`nat: '${token}' is not in the ssh config — did you mean: ${hints.join(", ")}?\n`);
    }
  }

  // Command order: inline (after `--`), then --command/-c, then --file.
  const commands: CommandSpec[] = [];
  try {
    for (const text of split.tail) commands.push(parseCommandSpec(text));
    for (const text of parsed.list("command")) commands.push(parseCommandSpec(text));
    const file = parsed.str("file", "");
    if (parsed.has("file")) {
      const text = file === "-" ? readStdin() : readFileSync(file, "utf8");
      for (const spec of readCommandText(text)) commands.push(spec);
    }
  } catch (err) {
    return fail(errorMessage(err));
  }
  if (commands.length === 0) {
    return fail("run requires at least one command (inline after `--`, --command, or --file)");
  }

  const options = new RunOptions();
  options.jump = parsed.str("jump", "");
  options.jumpShell = parsed.bool("jump-shell");
  options.enterSonicCli = parsed.bool("enter-sonic-cli");
  options.noSonicCli = parsed.bool("no-sonic-cli");
  options.noIosShell = parsed.bool("no-ios-shell");
  options.connectTimeout = parsed.int("connect-timeout", 20);
  options.commandTimeout = parsed.int("command-timeout", 30);
  options.driver = parsed.str("driver", "");
  options.username = parsed.str("user", "");
  options.raw = parsed.bool("raw");
  options.passwordByHost = inventory.passwordByHost;

  const parserSources = parsed.list("parsers");
  const parserCommand = parsed.str("parser-cmd", "");
  try {
    options.parsers = buildParserTable(parsed);
  } catch (err) {
    return fail(`failed to load parser pack: ${errorMessage(err)}`);
  }
  options.parse = parsed.bool("parse") || options.parsers !== null;

  if (parsed.bool("ask-pass")) {
    options.password = await promptSecret("SSH password: ");
  }

  const jsonMode = parsed.bool("json");
  const workers = parsed.int("workers", 5);
  const noStore = parsed.bool("no-store") || /^(1|true|yes|on)$/i.test(process.env["NAT_NO_STORE"] ?? "");
  const store = noStore ? RunStore.inMemory() : new RunStore(resolveRunPaths().runsDir);

  const workspace = new TransportWorkspace();
  const transport = buildTransportOptions(parsed);
  transport.configPath = prepareSshConfigFile(inventory, workspace, sshConfig, transport);

  const runId = randomUUID().replace(/-/g, "");
  const commandSources: string[] = [];
  for (const spec of commands) commandSources.push(spec.source);
  const sourceList = parserSources.length > 0 ? parserSources : parserCommand === "" ? [] : [parserCommand];
  store.createRun(runId, "run", runArgs(hosts, commandSources, runOptionsJson(options, sourceList)));
  if (!jsonMode) process.stdout.write(`run_id: ${runId}\n`);

  let stopping = false;
  const stop = (code: number): void => {
    if (stopping) return;
    stopping = true;
    // A signal does not run async finally blocks. Kill every ssh child before
    // deleting its control sockets/FIFOs, and leave a terminal run status for
    // an already attached `nat watch` process.
    store.setRunStatus(runId, STATUS_COMPLETED_WITH_ERRORS);
    workspace.dispose();
    store.close();
    process.exit(code);
  };
  const interrupt = (): void => stop(130);
  const terminate = (): void => stop(143);
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);

  try {
    const pending = runMany(store, runId, inventory, hosts, commands, options, transport, workspace, workers);
    let results: HostRunResult[];
    if (parsed.bool("watch") && !jsonMode) {
      await streamRunEvents(store, runId, pending);
      results = await pending;
    } else {
      results = await pending;
    }

    let failures = 0;
    for (const result of results) {
      if (!result.success) failures += 1;
    }
    store.setRunStatus(runId, failures > 0 ? STATUS_COMPLETED_WITH_ERRORS : STATUS_COMPLETED);

    if (jsonMode) {
      process.stdout.write(renderJsonPretty(resultsEnvelope(runId, results), 2) + "\n");
      return failures > 0 ? 1 : 0;
    }

    // The output shows by default: a run whose output you cannot see is
    // indistinguishable from one that returned nothing. `--watch` already
    // streamed it, and `--quiet` opts back into status lines only.
    if (!parsed.bool("watch") && !parsed.bool("quiet")) renderResults(results);
    for (const result of results) {
      const status = result.success ? "ok" : "error";
      const detail = result.error === "" ? "" : ` — ${result.error}`;
      process.stdout.write(`${result.hostAlias} (${result.hostname}): ${status}${detail}\n`);
    }
    return failures > 0 ? 1 : 0;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    store.close();
    workspace.dispose();
  }
}

/* --------------------------------- parse --------------------------------- */

function cmdParse(args: string[]): number {
  if (wantsHelp(args)) {
    process.stdout.write(HELP_PARSE + "\n");
    return 0;
  }
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(
      args,
      [
        stringOption("command", "c"),
        stringOption("input", "i"),
        stringOption("driver", ""),
        repeatedOption("parsers", ""),
        stringOption("parser-cmd", ""),
        booleanOption("json", ""),
      ],
      true,
    );
  } catch (err) {
    return fail(errorMessage(err));
  }

  const command = parsed.str("command", "");
  if (command === "") return fail("parse requires --command/-c to select a parser");

  let raw = "";
  const input = parsed.str("input", "");
  try {
    raw = input === "" ? readStdin() : readFileSync(input, "utf8");
  } catch (err) {
    return fail(`failed to read input: ${errorMessage(err)}`);
  }

  let custom: ParserTable | null = null;
  try {
    custom = buildParserTable(parsed);
  } catch (err) {
    return fail(`failed to load parser pack: ${errorMessage(err)}`);
  }

  const driverArg = parsed.str("driver", "");
  const driver = (driverArg === "" ? DEFAULT_DRIVER : driverArg).toLowerCase();
  const result = parseOutput(driver, command, raw, new ParserContext("(local)", command, driver), custom);
  if (result === null) {
    return fail(`no parser matched for driver '${driver}' command '${command}'`);
  }
  process.stdout.write((parsed.bool("json") ? renderJson(result) : renderJsonPretty(result, 2)) + "\n");
  return 0;
}

/* ------------------------------ watch/results ---------------------------- */

function eventEnvelope(event: SessionEvent): Json {
  const node = jobj();
  node.setNum("id", event.id);
  node.setStr("runId", event.runId);
  node.setStr("hostAlias", event.hostAlias);
  node.setStr("eventType", event.eventType);
  node.setStr("message", event.message);
  node.setNumOrNull("commandIndex", event.commandIndex < 0 ? null : event.commandIndex);
  node.setStrOrNull("commandText", event.commandText === "" ? null : event.commandText);
  if (event.parsed !== null) node.set("parsed", event.parsed);
  node.setStr("createdAt", event.createdAt);
  return node;
}

async function cmdWatch(args: string[]): Promise<number> {
  if (wantsHelp(args)) {
    process.stdout.write(HELP_WATCH + "\n");
    return 0;
  }
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(args, [booleanOption("json", ""), booleanOption("raw", "")], true);
  } catch (err) {
    return fail(errorMessage(err));
  }
  if (parsed.positionals.length === 0) return fail("watch requires a run-id");
  const runId = parsed.positionals[0];

  const store = new RunStore(resolveRunPaths().runsDir);
  try {
    store.finalizeRunIfResultsExist(runId);
    if (store.getRun(runId) === null) return fail(`unknown run-id: ${runId}`);
    let lastId = 0;
    while (true) {
      const rows = store.iterEvents(runId, lastId);
      if (rows.length > 0) {
        for (const row of rows) {
          lastId = row.id;
          if (parsed.bool("json")) process.stdout.write(renderJson(eventEnvelope(row)) + "\n");
          else printEvent(row);
        }
        continue;
      }
      // The owner can die after this watcher attaches. Recheck the pid-backed
      // stale-run repair on every idle poll so a crashed run never leaves
      // `nat watch` hanging forever.
      store.finalizeRunIfResultsExist(runId);
      const record = store.getRun(runId);
      if (record !== null && record.status !== "running") break;
      await sleep(200);
    }
    return 0;
  } finally {
    store.close();
  }
}

function cmdResults(args: string[]): number {
  if (wantsHelp(args)) {
    process.stdout.write(HELP_RESULTS + "\n");
    return 0;
  }
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(args, [booleanOption("json", ""), booleanOption("raw", "")], true);
  } catch (err) {
    return fail(errorMessage(err));
  }
  if (parsed.positionals.length === 0) return fail("results requires a run-id");
  const runId = parsed.positionals[0];

  const store = new RunStore(resolveRunPaths().runsDir);
  try {
    if (store.getRun(runId) === null) return fail(`unknown run-id: ${runId}`);
    const results = store.getResults(runId);
    if (parsed.bool("json")) {
      process.stdout.write(renderJsonPretty(resultsEnvelope(runId, results), 2) + "\n");
      return 0;
    }
    if (results.length === 0) {
      process.stdout.write("(no results recorded yet)\n");
      return 0;
    }
    renderResults(results);
    return 0;
  } finally {
    store.close();
  }
}

function cmdRuns(args: string[]): number {
  if (wantsHelp(args)) {
    process.stdout.write(HELP_RUNS + "\n");
    return 0;
  }
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(args, [stringOption("host", ""), stringOption("limit", "")], true);
  } catch (err) {
    return fail(errorMessage(err));
  }
  const limit = parsed.int("limit", 50);
  const host = parsed.str("host", "");
  const store = new RunStore(resolveRunPaths().runsDir);
  try {
    const runs = host !== "" ? store.listRunsForHost(host, limit) : store.listRuns(limit);
    if (runs.length === 0) {
      process.stdout.write("(no runs recorded)\n");
      return 0;
    }
    for (const run of runs) {
      process.stdout.write(
        `${run.runId}  ${formatTimestamp(run.createdAt)}  ${run.status}  ${run.commandName}\n`,
      );
    }
    return 0;
  } finally {
    store.close();
  }
}

/* ------------------------------- credentials ----------------------------- */

async function cmdCred(args: string[], sshConfig: string): Promise<number> {
  if (wantsHelp(args)) {
    process.stdout.write(HELP_CRED + "\n");
    return 0;
  }
  const sub = args.length > 0 ? args[0] : "";
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(
      args.slice(1),
      [stringOption("user", ""), stringOption("kind", ""), stringOption("secret", "")],
      true,
    );
  } catch (err) {
    return fail(errorMessage(err));
  }
  if (parsed.positionals.length === 0) return fail(`cred ${sub} requires a host alias`);
  const alias = parsed.positionals[0];

  let user = parsed.str("user", "");
  if (user === "") {
    try {
      const inventory = loadInventory(sshConfig);
      user = resolveInventoryHostWithSsh(inventory, alias, sshConfig).user;
    } catch (err) {
      // The inventory is optional for credential operations.
    }
  }
  if (user === "") return fail("could not determine user; pass --user");

  const kind = normalizeKind(parsed.str("kind", "password"));

  try {
    if (sub === "set") {
      const provided = parsed.str("secret", "");
      const secret = provided !== "" ? provided : await promptSecret(`${kind} for ${user}@${alias}: `);
      setSecret(alias, user, secret, kind);
      process.stdout.write(`stored ${kind} for ${user}@${alias}\n`);
      if (credentialBackend() === BACKEND_FILE) {
        process.stderr.write(`nat: warning: no OS keyring found; secret stored in ${backendDescription()}\n`);
      }
      return 0;
    }
    if (sub === "delete") {
      const removed = deleteSecret(alias, user, kind);
      process.stdout.write(
        removed ? `deleted ${kind} for ${user}@${alias}\n` : `no ${kind} stored for ${user}@${alias}\n`,
      );
      return 0;
    }
    if (sub === "get") {
      const value = getSecret(alias, user, kind);
      process.stdout.write(value !== "" ? "(secret present)\n" : "(not set)\n");
      return value !== "" ? 0 : 1;
    }
  } catch (err) {
    if (err instanceof CredentialError) return fail(err.message);
    throw err;
  }

  return fail("cred expects `set`, `get`, or `delete`");
}

/* --------------------------------- doctor -------------------------------- */

function cmdDoctor(args: string[], sshConfig: string): number {
  if (wantsHelp(args)) {
    process.stdout.write(HELP_DOCTOR + "\n");
    return 0;
  }
  const transport = new TransportOptions();
  const paths = resolveRunPaths();
  const configPath = sshConfig === "" ? defaultSshConfigPath() : sshConfig;

  process.stdout.write(`nat:          ${VERSION}\n`);
  process.stdout.write(`platform:     ${platform()}\n`);
  process.stdout.write(`ssh client:   ${transport.sshBin}${commandExists(transport.sshBin) ? "" : "  (NOT FOUND)"}\n`);
  // OpenSSH prints its version banner on stderr, so the probe reads both streams.
  const sshVersion = probeCommand(transport.sshBin, ["-V"]);
  process.stdout.write(`ssh version:  ${sshVersion === "" ? "(unknown)" : sshVersion}\n`);
  process.stdout.write(`ssh config:   ${configPath}${existsSync(configPath) ? "" : "  (missing)"}\n`);
  process.stdout.write(`secret store: ${backendDescription()}\n`);
  process.stdout.write(`run history:  ${paths.runsDir}\n`);

  let aliases = 0;
  try {
    aliases = listHostAliases(loadInventory(sshConfig).config).length;
  } catch (err) {
    aliases = -1;
  }
  process.stdout.write(`host aliases: ${aliases < 0 ? "(config unreadable)" : `${aliases}`}\n`);
  return 0;
}

/* ---------------------------------- main --------------------------------- */

async function main(argv: string[]): Promise<number> {
  if (argv.length === 0) {
    process.stdout.write(USAGE);
    return 2;
  }
  if (argv[0] === "-h" || argv[0] === "--help") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (argv[0] === "-v" || argv[0] === "--version") {
    process.stdout.write(`nat ${VERSION}\n`);
    return 0;
  }

  try {
    const globals = extractSshConfig(argv);
    const command = globals.rest.length > 0 ? globals.rest[0] : "";
    const args = globals.rest.slice(1);

    if (command === "inventory") return cmdInventory(args, globals.sshConfig);
    if (command === "run") return await cmdRun(args, globals.sshConfig);
    if (command === "parse") return cmdParse(args);
    if (command === "watch") return await cmdWatch(args);
    if (command === "results") return cmdResults(args);
    if (command === "runs") return cmdRuns(args);
    if (command === "cred") return await cmdCred(args, globals.sshConfig);
    if (command === "doctor") return cmdDoctor(args, globals.sshConfig);
    if (command === "") {
      process.stdout.write(USAGE);
      return 2;
    }
    return fail(`unknown command: ${command}`);
  } catch (err) {
    if (err instanceof InventoryError) return fail(err.message);
    if (err instanceof CredentialError) return fail(err.message);
    if (err instanceof ConnectionError) return fail(err.message);
    if (err instanceof ParserPackError) return fail(err.message);
    if (err instanceof ArgError) return fail(err.message);
    return fail(errorMessage(err));
  }
}

main(process.argv.slice(2)).then((code: number) => {
  // Node's process.exit() can truncate a large write to piped stdout/stderr.
  // A zero-byte write callback is a stream barrier: it runs after every prior
  // write on that stream. The native runtime writes synchronously, so the same
  // code is an immediate no-op there.
  let pending = 2;
  const flushed = (): void => {
    pending -= 1;
    if (pending === 0) process.exit(code);
  };
  process.stdout.write("", flushed);
  process.stderr.write("", flushed);
});
