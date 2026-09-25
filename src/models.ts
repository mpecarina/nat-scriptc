/**
 * The shared data carriers.
 *
 * Absent optional values are represented by an empty string (text), `-1`
 * (indices) or `null` (structured values) rather than `undefined`: the JSON
 * envelope decides at render time whether a field is omitted or emitted as
 * `null`, and the internal code never has to narrow an optional union.
 */

import { Json } from "./json.ts";

/** Default SSH port when a host block sets none. */
export const DEFAULT_PORT = 22;

/** Condition operators for `when <op>:<value> :: <command>` lines. */
export const OP_CONTAINS = "contains";
export const OP_NOT_CONTAINS = "not_contains";
export const OP_EQUALS = "equals";
export const OP_NOT_EQUALS = "not_equals";

/** One host as nat resolved it: ssh-config values plus nat's driver keyword. */
export class HostConfig {
  alias: string;
  hostname: string;
  /** Login user, or "" to let ssh pick (ssh_config `User`, else the local user). */
  user: string;
  port: number;
  identityFiles: string[];
  identitiesOnly: boolean;
  /** ProxyJump specification, or "" for a direct connection. */
  proxyJump: string;
  /** Driver / target OS used to scope output parsers, or "" for the default. */
  targetOs: string;

  constructor(alias: string) {
    this.alias = alias;
    this.hostname = alias;
    this.user = "";
    this.port = DEFAULT_PORT;
    this.identityFiles = [];
    this.identitiesOnly = false;
    this.proxyJump = "";
    this.targetOs = "";
  }
}

/** One command to run, with the condition that gates it (if any). */
export class CommandSpec {
  text: string;
  /** The original line, as typed — what run history records. */
  source: string;
  /** "" when unconditional, else one of the OP_* constants. */
  conditionOperator: string;
  conditionValue: string;

  constructor(text: string, source: string) {
    this.text = text;
    this.source = source;
    this.conditionOperator = "";
    this.conditionValue = "";
  }

  hasCondition(): boolean {
    return this.conditionOperator !== "";
  }
}

/** One command's result: what was sent, what came back, and its parsed shape. */
export class CommandResult {
  command: string;
  output: string;
  /** Structured output when --parse is on, else null (the field is omitted). */
  parsed: Json | null;

  constructor(command: string, output: string) {
    this.command = command;
    this.output = output;
    this.parsed = null;
  }
}

/** Everything one host produced during a run. */
export class HostRunResult {
  hostAlias: string;
  hostname: string;
  success: boolean;
  /** Driver name when --parse is on, "sonic" when sonic-cli was entered, else "". */
  platform: string;
  /** "" when the host succeeded. */
  error: string;
  commands: CommandResult[];
  /** Set only on a result read back from history. */
  createdAt: string;

  constructor(hostAlias: string, hostname: string) {
    this.hostAlias = hostAlias;
    this.hostname = hostname;
    this.success = false;
    this.platform = "";
    this.error = "";
    this.commands = [];
    this.createdAt = "";
  }
}

/** One line of a run's event stream. */
export class SessionEvent {
  /** Monotonic per-run sequence number; 0 before the store assigns one. */
  id: number;
  runId: string;
  hostAlias: string;
  eventType: string;
  message: string;
  /** Index into the run's command list, or -1 for host-level events. */
  commandIndex: number;
  commandText: string;
  parsed: Json | null;
  createdAt: string;

  constructor(runId: string, hostAlias: string, eventType: string, message: string) {
    this.id = 0;
    this.runId = runId;
    this.hostAlias = hostAlias;
    this.eventType = eventType;
    this.message = message;
    this.commandIndex = -1;
    this.commandText = "";
    this.parsed = null;
    this.createdAt = "";
  }
}

/** A run's header record. */
export class RunRecord {
  runId: string;
  commandName: string;
  createdAt: string;
  status: string;
  /** The run's arguments, kept verbatim for `nat runs`/`nat results` context. */
  args: Json;
  /** Process that owns a running record. */
  ownerPid: number;

  constructor(runId: string, commandName: string, createdAt: string, status: string) {
    this.runId = runId;
    this.commandName = commandName;
    this.createdAt = createdAt;
    this.status = status;
    this.args = new Json("obj");
    this.ownerPid = -1;
  }
}

/** Where nat keeps its state. */
export class RunPaths {
  runsDir: string;
  credentialsPath: string;

  constructor(runsDir: string, credentialsPath: string) {
    this.runsDir = runsDir;
    this.credentialsPath = credentialsPath;
  }
}

/** The context handed to every parser. */
export class ParserContext {
  host: string;
  command: string;
  driver: string;

  constructor(host: string, command: string, driver: string) {
    this.host = host;
    this.command = command;
    this.driver = driver;
  }
}
