/**
 * Per-host command execution and fan-out.
 *
 * One host, one connection, N commands. Which channel those commands take
 * depends on the driver: SONiC and the Cisco CLIs are driven through an
 * interactive session (their config modes and paging controls only exist
 * there), everything else runs over ordinary exec channels.
 */

import { Json, jarr, jobj, jstr } from "./json.ts";
import { CommandResult, CommandSpec, HostConfig, HostRunResult, ParserContext, SessionEvent } from "./models.ts";
import { conditionMatches, skipReason } from "./command-files.ts";
import { DEFAULT_DRIVER, ParserTable, parseOutput } from "./drivers.ts";
import { Inventory, resolveHost } from "./inventory.ts";
import { resolvePassphrase, resolvePassword } from "./credentials.ts";
import { stripCommandEcho, trimTrailingNewlines } from "./output.ts";
import { ProcessResult } from "./process.ts";
import {
  ConnectionError,
  ConnectionTarget,
  SSH_ERROR_EXIT,
  ShellChannel,
  SshConnection,
  TransportOptions,
  TransportWorkspace,
  resolveEffectiveHost,
  splitJumpSpec,
} from "./transport.ts";
import {
  enterSonicCli,
  openShell,
  prepareIosCli,
  prepareSonicCli,
  runShellText,
  startNestedSsh,
  widenUnixPty,
} from "./session.ts";
import { RunStore } from "./store.ts";

export const EVENT_HOST_START = "host_start";
export const EVENT_HOST_COMPLETE = "host_complete";
export const EVENT_HOST_ERROR = "host_error";
export const EVENT_COMMAND_OUTPUT = "command_output";
export const EVENT_COMMAND_SKIPPED = "command_skipped";

/** Everything `nat run` decided before any host was touched. */
export class RunOptions {
  /** ProxyJump override; "" keeps each host's own. */
  jump: string;
  jumpShell: boolean;
  enterSonicCli: boolean;
  noSonicCli: boolean;
  noIosShell: boolean;
  connectTimeout: number;
  commandTimeout: number;
  parse: boolean;
  /** Driver override for every host; "" keeps each host's own. */
  driver: string;
  /** Login user override for every host; "" keeps each host's own. */
  username: string;
  parsers: ParserTable | null;
  /** A password to use for every host (`--ask-pass`); "" when unset. */
  password: string;
  /** Per-host passwords keyed by alias (from a JSON inventory). */
  passwordByHost: Map<string, string>;
  /** Keep raw transcripts: skip the echo/prompt cleanup. */
  raw: boolean;

  constructor() {
    this.jump = "";
    this.jumpShell = false;
    this.enterSonicCli = false;
    this.noSonicCli = false;
    this.noIosShell = false;
    this.connectTimeout = 20;
    this.commandTimeout = 30;
    this.parse = false;
    this.driver = "";
    this.username = "";
    this.parsers = null;
    this.password = "";
    this.passwordByHost = new Map<string, string>();
    this.raw = false;
  }
}

/**
 * The effective driver for a host: an explicit `--driver` wins, then the host's
 * own `#nat-driver`, then the default.
 */
export function effectiveDriver(host: HostConfig, options: RunOptions): string {
  if (options.driver !== "") return options.driver.toLowerCase();
  if (host.targetOs !== "") return host.targetOs.toLowerCase();
  return DEFAULT_DRIVER;
}

/**
 * Whether to enter the SONiC CLI. Entered when the host's driver is "sonic"
 * (per-host, e.g. from a JSON inventory) or when `--enter-sonic-cli` is set,
 * unless `--no-sonic-cli` disables it — which keeps plain Linux hosts from
 * hanging on a `sonic-cli` that does not exist.
 */
export function shouldEnterSonicCli(host: HostConfig, options: RunOptions): boolean {
  if (options.noSonicCli) return false;
  return options.enterSonicCli || effectiveDriver(host, options) === "sonic";
}

/**
 * Whether to drive a Cisco CLI host through an interactive session. IOS-XE and
 * NX-OS exec channels do not reliably apply a multi-line `configure terminal`
 * block, and the session path also disables paging for read-only collection.
 * `--no-ios-shell` is the escape hatch.
 */
export function shouldUseIosShell(host: HostConfig, options: RunOptions): boolean {
  if (options.noIosShell) return false;
  const driver = effectiveDriver(host, options);
  return driver === "ios" || driver === "nxos";
}

const VYOS_OP_WRAPPER = "/opt/vyatta/bin/vyatta-op-cmd-wrapper";
const VYOS_OP_VERB =
  /^(show|ping|traceroute|mtr|monitor|generate|reset|restart|force|run|telnet|release|renew|disconnect|clear)\b/;

/**
 * VyOS op-mode verbs ("show …", "ping …") are invalid in a non-interactive
 * shell — VyOS answers "Invalid command: [show]". Bare verbs are routed through
 * VyOS's op-mode wrapper so `--driver vyos -c "show ip route"` works directly.
 * The recorded command name stays the bare form, so `--parse` still selects the
 * vyos parser by its clean key. A command that is already a shell line (starts
 * with a path, contains a pipe) or already wrapped is left alone, so
 * pre-wrapped batches are never double-wrapped.
 */
export function execTextForDriver(driver: string, command: string): string {
  if (driver !== "vyos") return command;
  const trimmed = command.trim();
  if (!VYOS_OP_VERB.test(trimmed)) return command;
  if (trimmed.includes("vyatta-op-cmd-wrapper") || trimmed.includes("|")) return command;
  return `${VYOS_OP_WRAPPER} ${trimmed}`;
}

/** The password for a host: inventory map, then the shared `--ask-pass` value. */
function passwordForHost(host: HostConfig, options: RunOptions): string {
  const fromMap = options.passwordByHost.get(host.alias);
  if (fromMap !== undefined && fromMap !== "") return fromMap;
  return options.password;
}

/** A live session for one host: the connection plus, in shell mode, its channel. */
class PreparedSession {
  connection: SshConnection;
  channel: ShellChannel | null;
  prompt: string;
  useShell: boolean;

  constructor(connection: SshConnection) {
    this.connection = connection;
    this.channel = null;
    this.prompt = "";
    this.useShell = false;
  }

  close(): void {
    if (this.channel !== null) this.channel.end();
    this.connection.close();
  }
}

/** ssh's own failure text, when a command's exit means the connection died. */
function connectionFailureText(result: ProcessResult): string {
  if (result.spawnError !== "") return `cannot run ssh (${result.spawnError})`;
  if (result.code !== SSH_ERROR_EXIT || result.stdout !== "") return "";
  if (
    /(Permission denied|Connection refused|Connection closed|Connection timed out|Could not resolve|No route to host|Host key verification|kex_exchange|Bad configuration|Control socket connect)/i.test(
      result.stderr,
    )
  ) {
    const lines = result.stderr.trim().split(/\r?\n/);
    return lines[lines.length - 1].trim();
  }
  return "";
}

/** One `[user@]host[:port]` jump hop. `user` is "" and `port` -1 when not given. */
class JumpHop {
  user: string;
  alias: string;
  port: number;

  constructor(user: string, alias: string, port: number) {
    this.user = user;
    this.alias = alias;
    this.port = port;
  }
}

function parseJumpHop(spec: string): JumpHop {
  let remainder = spec.trim();
  let user = "";
  const at = remainder.lastIndexOf("@");
  if (at >= 0) {
    user = remainder.slice(0, at);
    remainder = remainder.slice(at + 1);
  }

  let alias = remainder;
  let rawPort = "";
  if (remainder.startsWith("[")) {
    const close = remainder.indexOf("]");
    if (close > 0) {
      alias = remainder.slice(1, close);
      if (remainder.slice(close + 1).startsWith(":")) rawPort = remainder.slice(close + 2);
    }
  } else {
    const colon = remainder.lastIndexOf(":");
    // More than one colon is an unbracketed IPv6 literal, not host:port.
    if (colon >= 0 && remainder.indexOf(":") === colon) {
      const parsed = Number(remainder.slice(colon + 1));
      if (Number.isFinite(parsed) && parsed > 0) {
        alias = remainder.slice(0, colon);
        rawPort = remainder.slice(colon + 1);
      }
    }
  }

  const port = Number(rawPort);
  const valid = rawPort !== "" && Number.isFinite(port) && port > 0 && port <= 65535;
  return new JumpHop(user, alias, valid ? Math.trunc(port) : -1);
}

/** Resolve a jump hop the way ssh will connect to it. */
function jumpHopHost(inventory: Inventory, transport: TransportOptions, hop: JumpHop, priorHops: string): HostConfig {
  return resolveEffectiveHost(transport, resolveHost(inventory.config, hop.alias), hop.user, hop.port, priorHops);
}

/** Last path component, useful because ssh may expand `~` before prompting. */
function pathTail(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? path : path.slice(slash + 1);
}

/**
 * Give each ProxyJump hop its own stored password/passphrase. Every ssh
 * descendant shares one askpass helper, so secrets are routed by the prompt
 * text that names the hop (`<alias>'s password`) or its key file.
 */
function addProxyJumpSecrets(
  inventory: Inventory,
  target: ConnectionTarget,
  spec: string,
  transport: TransportOptions,
): void {
  for (const hopSpec of splitJumpSpec(spec)) {
    const hop = jumpHopHost(inventory, transport, parseJumpHop(hopSpec), "");

    const password = resolvePassword(hop.alias, hop.user, "");
    // An empty mapped value is intentional: if the target has a password but a
    // hop does not, never offer the target's secret to the jump host.
    target.addPromptSecret(`${hop.alias}'s password`, password);
    if (hop.hostname !== hop.alias) target.addPromptSecret(`${hop.hostname}'s password`, password);

    const passphrase = resolvePassphrase(hop.alias, hop.user, "");
    if (passphrase === "" || hop.identityFiles.length === 0) continue;
    // Only the first effective IdentityFile gets the stored passphrase; other
    // keys are left to ssh-agent or the platform keychain.
    for (const identity of hop.identityFiles.slice(0, 1)) {
      target.addPromptSecret(identity, passphrase);
      const tail = pathTail(identity);
      if (tail !== identity) target.addPromptSecret(tail, passphrase);
    }
  }
}

/** Open the connection and, when the driver calls for it, its shell session. */
async function prepareSession(
  inventory: Inventory,
  host: HostConfig,
  options: RunOptions,
  transport: TransportOptions,
  workspace: TransportWorkspace,
): Promise<PreparedSession> {
  const hostPassword = passwordForHost(host, options);
  const password = resolvePassword(host.alias, host.user, hostPassword);

  if (options.jumpShell) {
    // Tunnel through the jump host's own shell: connect to the final hop, open
    // a session there, and type `ssh <target>` into it.
    const spec = options.jump !== "" ? options.jump : host.proxyJump;
    const hops = splitJumpSpec(spec);
    if (hops.length === 0) {
      throw new ConnectionError("--jump-shell requires a jump host (ProxyJump or --jump)");
    }
    const last = parseJumpHop(hops[hops.length - 1]);
    const priorHops = hops.length > 1 ? hops.slice(0, hops.length - 1).join(",") : "";
    const finalHop = jumpHopHost(inventory, transport, last, priorHops);
    const target = new ConnectionTarget(finalHop);
    target.userOverride = last.user;
    target.portOverride = last.port;
    // The jump host authenticates on its own account, so it gets its own
    // stored secret rather than the target's.
    target.password = resolvePassword(finalHop.alias, finalHop.user, "");
    target.passphrase = resolvePassphrase(finalHop.alias, finalHop.user, "");
    if (priorHops !== "") target.jumpOverride = priorHops;
    const connection = new SshConnection(transport, workspace, target);
    await connection.open();

    const prepared = new PreparedSession(connection);
    try {
      const start = await openShell(connection, 400);
      prepared.channel = start.channel;
      prepared.prompt = await startNestedSsh(
        start.channel,
        start.prompt,
        host.user,
        host.hostname,
        host.port,
        password,
        Math.max(options.connectTimeout, 30),
      );
    } catch (err) {
      // The connection is already open at this point; releasing it here keeps a
      // failed session from leaving a master process behind.
      prepared.close();
      throw err;
    }
    prepared.useShell = true;
    return prepared;
  }

  const target = new ConnectionTarget(host);
  if (options.username !== "") target.userOverride = options.username;
  target.password = password;
  target.passphrase = resolvePassphrase(host.alias, host.user, "");
  if (options.jump !== "") target.jumpOverride = options.jump;
  addProxyJumpSecrets(inventory, target, host.proxyJump, transport);
  const connection = new SshConnection(transport, workspace, target);
  await connection.open();
  const prepared = new PreparedSession(connection);

  try {
    if (shouldEnterSonicCli(host, options)) {
      const start = await openShell(connection, 400);
      prepared.channel = start.channel;
      // SONiC starts in a Unix shell, so the pty can be widened before the CLI
      // is entered — otherwise `show interface status` wraps at 80 columns.
      await widenUnixPty(start.channel, start.prompt, options.commandTimeout);
      const sonic = await enterSonicCli(start.channel, start.prompt, Math.max(options.connectTimeout, 15));
      await prepareSonicCli(start.channel, sonic.prompt, options.commandTimeout);
      prepared.prompt = sonic.prompt;
      prepared.useShell = true;
      return prepared;
    }

    if (shouldUseIosShell(host, options)) {
      const start = await openShell(connection, 400);
      prepared.channel = start.channel;
      prepared.prompt = await prepareIosCli(
        start.channel,
        start.prompt,
        password,
        Math.max(options.connectTimeout, 20),
      );
      prepared.useShell = true;
      return prepared;
    }
  } catch (err) {
    prepared.close();
    throw err;
  }

  return prepared;
}

/** Run every command against one host and record the result. */
export async function runHost(
  store: RunStore,
  runId: string,
  inventory: Inventory,
  hostAlias: string,
  commands: CommandSpec[],
  options: RunOptions,
  transport: TransportOptions,
  workspace: TransportWorkspace,
): Promise<HostRunResult> {
  const emit = (eventType: string, message: string, index: number, text: string, parsed: Json | null): void => {
    const event = new SessionEvent(runId, hostAlias, eventType, message);
    event.commandIndex = index;
    event.commandText = text;
    event.parsed = parsed;
    store.appendEvent(event);
  };

  let host: HostConfig;
  try {
    host = resolveHost(inventory.config, hostAlias);
    host = resolveEffectiveHost(transport, host, options.username, -1, options.jump);
  } catch (err) {
    const message = err instanceof Error ? err.message : "could not resolve host";
    emit(EVENT_HOST_ERROR, message, -1, "", null);
    const failure = new HostRunResult(hostAlias, hostAlias);
    failure.error = message;
    store.saveHostResult(runId, failure);
    return failure;
  }

  const driverName = effectiveDriver(host, options);
  const sonicActive = shouldEnterSonicCli(host, options);
  const result = new HostRunResult(hostAlias, host.hostname);

  emit(EVENT_HOST_START, `connecting to ${host.hostname}`, -1, "", null);

  let prepared: PreparedSession | null = null;
  try {
    prepared = await prepareSession(inventory, host, options, transport, workspace);
    let lastOutput = "";

    for (let index = 0; index < commands.length; index += 1) {
      const spec = commands[index];
      if (spec.hasCondition() && !conditionMatches(spec, lastOutput)) {
        emit(EVENT_COMMAND_SKIPPED, skipReason(spec), index, spec.text, null);
        continue;
      }

      let rawOutput = "";
      if (prepared.useShell && prepared.channel !== null) {
        rawOutput = await runShellText(prepared.channel, spec.text, prepared.prompt, options.commandTimeout);
      } else {
        const exec = await prepared.connection.exec(
          execTextForDriver(driverName, spec.text),
          options.commandTimeout,
        );
        const failure = connectionFailureText(exec);
        if (failure !== "") throw new ConnectionError(`Failed connecting to ${hostAlias}: ${failure}`);
        rawOutput = exec.output;
      }

      // Echo/prompt cleanup belongs here — this is the only layer that knows
      // whether an interactive session was used. Consumers render `output`
      // as-is; stripping again downstream destroys real output, because an
      // error naming the command looks exactly like an echo.
      const cleaned =
        prepared.useShell && !options.raw
          ? stripCommandEcho(spec.text, rawOutput, prepared.prompt)
          : trimTrailingNewlines(rawOutput);
      lastOutput = cleaned;

      const entry = new CommandResult(spec.text, cleaned);
      if (options.parse) {
        entry.parsed = parseOutput(
          driverName,
          spec.text,
          cleaned,
          new ParserContext(hostAlias, spec.text, driverName),
          options.parsers,
        );
      }
      result.commands.push(entry);
      // The event carries the same value that is stored, so `--watch`,
      // `nat results` and the end-of-run render all agree.
      emit(EVENT_COMMAND_OUTPUT, cleaned, index, spec.text, entry.parsed);
    }

    emit(EVENT_HOST_COMPLETE, "completed", -1, "", null);
    result.success = true;
    result.platform = options.parse ? driverName : sonicActive ? "sonic" : "";
    store.saveHostResult(runId, result);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : "host failed";
    emit(EVENT_HOST_ERROR, message, -1, "", null);
    result.success = false;
    result.platform = sonicActive ? "sonic" : "";
    result.error = message;
    store.saveHostResult(runId, result);
    return result;
  } finally {
    if (prepared !== null) prepared.close();
  }
}

/** Run every host, at most `workers` at a time. */
export async function runMany(
  store: RunStore,
  runId: string,
  inventory: Inventory,
  hostAliases: string[],
  commands: CommandSpec[],
  options: RunOptions,
  transport: TransportOptions,
  workspace: TransportWorkspace,
  workers: number,
): Promise<HostRunResult[]> {
  const queue: string[] = [];
  for (const alias of hostAliases) queue.push(alias);
  const results: HostRunResult[] = [];
  const poolSize = Math.max(1, Math.min(workers, hostAliases.length === 0 ? 1 : hostAliases.length));

  const worker = async (): Promise<void> => {
    while (queue.length > 0) {
      const alias = queue.shift();
      if (alias === undefined) break;
      results.push(await runHost(store, runId, inventory, alias, commands, options, transport, workspace));
    }
  };

  const running: Promise<void>[] = [];
  for (let i = 0; i < poolSize; i += 1) running.push(worker());
  await Promise.all(running);
  return results;
}

/** The `options` blob recorded with a run. */
export function runOptionsJson(options: RunOptions, parserSources: string[]): Json {
  const node = jobj();
  node.setStrOrNull("jump", options.jump === "" ? null : options.jump);
  node.setBool("jumpShell", options.jumpShell);
  node.setBool("enterSonicCli", options.enterSonicCli);
  node.setNum("connectTimeout", options.connectTimeout);
  node.setNum("commandTimeout", options.commandTimeout);
  node.setBool("parse", options.parse);
  node.setStrOrNull("driver", options.driver === "" ? null : options.driver);
  const list = jarr();
  for (const source of parserSources) list.push(jstr(source));
  node.set("parsers", list);
  return node;
}
