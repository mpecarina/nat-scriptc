/**
 * The host inventory.
 *
 * Two sources produce the same shape: the user's ssh client config, and a JSON
 * lab inventory (the schema the lab's `/api/labs/:id/inventory.json` endpoint emits). The
 * JSON source is translated into a synthetic ssh config so selection,
 * resolution and the ssh transport all work against one representation — and so
 * the generated file can be handed to `ssh -F` unchanged.
 */

import { existsSync, readFileSync } from "node:fs";

import { Json, jsonAsString, parseJson } from "./json.ts";
import { DEFAULT_PORT, HostConfig } from "./models.ts";
import { expandUser, defaultSshConfigPath } from "./paths.ts";
import {
  DRIVER_KEY,
  SshConfig,
  computeHost,
  keywordValue,
  listHostAliases,
  parseSshConfigFile,
  parseSshConfigText,
} from "./sshconfig.ts";
import { globToRegExp, isGlob, parseIntPrefix } from "./text.ts";

export class InventoryError extends Error {}

/** A device the JSON inventory could not turn into a usable host. */
export class SkippedDevice {
  id: string;
  reason: string;

  constructor(id: string, reason: string) {
    this.id = id;
    this.reason = reason;
  }
}

/** A loaded inventory, whatever its source. */
export class Inventory {
  config: SshConfig;
  /** The file it came from, or "(json)" / "(memory)". */
  path: string;
  /** Plaintext passwords carried by a JSON inventory, keyed by alias. */
  passwordByHost: Map<string, string>;
  skipped: SkippedDevice[];
  /** Usable devices in a JSON inventory; -1 for an ssh-config inventory. */
  deviceCount: number;
  /**
   * ssh-config text nat generated itself (JSON inventories). "" when the
   * inventory is a real file the ssh binary can read directly.
   */
  syntheticText: string;

  constructor(config: SshConfig, path: string) {
    this.config = config;
    this.path = path;
    this.passwordByHost = new Map<string, string>();
    this.skipped = [];
    this.deviceCount = -1;
    this.syntheticText = "";
  }
}

/** Read the ssh client config (default `~/.ssh/config`) as the inventory. */
export function loadInventory(configPath: string): Inventory {
  const resolved = configPath === "" ? defaultSshConfigPath() : expandUser(configPath);
  if (!existsSync(resolved)) {
    // A user config is optional to OpenSSH. Keep an empty inventory for literal
    // hosts so `nat run host ...` still benefits from /etc/ssh/ssh_config,
    // default keys, ssh-agent and the local login user. An explicitly requested
    // file remains an error because silently ignoring a typo would be surprising.
    if (configPath === "") return new Inventory(parseSshConfigText("", resolved), resolved);
    throw new InventoryError(`SSH config not found: ${resolved}`);
  }
  return new Inventory(parseSshConfigFile(resolved), resolved);
}

/** True when a host token is a glob pattern rather than a literal name. */
export function isHostPattern(token: string): boolean {
  return isGlob(token);
}

/** An alias and its `#nat-driver`; `resolveEffectiveHost` (`ssh -G`) supplies the connection fields. */
export function resolveHost(config: SshConfig, alias: string): HostConfig {
  const host = new HostConfig(alias);
  host.targetOs = keywordValue(computeHost(config, alias), DRIVER_KEY, "");
  return host;
}

/** The outcome of expanding the requested host tokens. */
export class HostSelection {
  hosts: string[];
  /** Globs (and `--all`) that matched no alias in the inventory. */
  unmatched: string[];

  constructor() {
    this.hosts = [];
    this.unmatched = [];
  }
}

/**
 * Resolve requested host tokens into a concrete, de-duplicated host list.
 * `--all` expands to every alias; `*`/`?` tokens are globbed against the known
 * aliases; a literal token passes through unchanged (it may be an alias, an IP,
 * or an FQDN that is not in the config at all).
 */
export function selectHosts(config: SshConfig, requested: string[], includeAll: boolean): HostSelection {
  const aliases = listHostAliases(config);
  const selection = new HostSelection();

  if (includeAll) {
    if (aliases.length === 0) selection.unmatched.push("--all");
    for (const alias of aliases) {
      if (!selection.hosts.includes(alias)) selection.hosts.push(alias);
    }
  }

  for (const token of requested) {
    if (isHostPattern(token)) {
      const matcher = globToRegExp(token);
      let matched = false;
      for (const alias of aliases) {
        if (!matcher.test(alias)) continue;
        matched = true;
        if (!selection.hosts.includes(alias)) selection.hosts.push(alias);
      }
      if (!matched) selection.unmatched.push(token);
      continue;
    }
    if (!selection.hosts.includes(token)) selection.hosts.push(token);
  }

  return selection;
}

/**
 * Aliases close to an unknown literal host, for a "did you mean" hint. The
 * heuristic is deliberately cheap so a genuine hostname or IP — which shares no
 * prefix with any alias — produces no suggestions and stays silent.
 */
export function suggestAliases(config: SshConfig, host: string): string[] {
  const aliases = listHostAliases(config);
  if (aliases.includes(host)) return [];
  const lower = host.toLowerCase();
  const prefix = lower.slice(0, 3);
  const hints: string[] = [];
  for (const alias of aliases) {
    if (hints.length >= 3) break;
    const candidate = alias.toLowerCase();
    if (prefix.length >= 2 && candidate.startsWith(prefix)) {
      hints.push(alias);
      continue;
    }
    if (candidate.includes(lower) || lower.includes(candidate)) hints.push(alias);
  }
  return hints;
}

const SAFE_TOKEN = /^[A-Za-z0-9._-]+$/;
const SAFE_HOSTNAME = /^[A-Za-z0-9._:-]+$/;
const SAFE_PATH = /^[A-Za-z0-9._/~-]+$/;

function sanitizeToken(value: string): string {
  const text = value.trim();
  return text !== "" && SAFE_TOKEN.test(text) ? text : "";
}

/** Validate an IdentityFile path against a conservative allow-list. */
function sanitizePath(value: string): string {
  const text = value.trim();
  return text !== "" && SAFE_PATH.test(text) ? text : "";
}

/** A member as trimmed text (numbers stringify), or "" when absent. */
function textMember(device: Json, key: string): string {
  const value = device.get(key);
  return value === null ? "" : jsonAsString(value, "").trim();
}

/** A member only when it is literally a JSON string (passwords are not coerced). */
function stringMember(device: Json, key: string): string {
  const value = device.get(key);
  return value !== null && value.kind === "str" ? value.s : "";
}

/**
 * Read a JSON lab inventory and translate it into an in-memory ssh config.
 *
 * The generated config is nat's own, never written over the user's, so it can
 * carry a per-host driver — emitted as `#nat-driver`, the comment form every
 * ssh version ignores, because the same text is handed to `ssh -F`.
 *
 * Every value is validated against a strict allow-list before it reaches the
 * config text: an untrusted inventory must not be able to inject ssh keywords.
 */
export function loadJsonInventory(filePath: string): Inventory {
  const resolved = expandUser(filePath);
  if (!existsSync(resolved)) {
    throw new InventoryError(`inventory file not found: ${resolved}`);
  }

  let root: Json;
  try {
    root = parseJson(readFileSync(resolved, "utf8"));
  } catch (err) {
    const detail = err instanceof Error ? err.message : "unreadable";
    throw new InventoryError(`inventory file is not valid JSON: ${detail}`);
  }

  const devices = root.kind === "obj" ? root.get("devices") : null;
  if (devices === null || devices.kind !== "arr") {
    throw new InventoryError("inventory file must be an object with a `devices` array (lab inventory schema)");
  }

  const blocks: string[] = [];
  const passwordByHost = new Map<string, string>();
  const skipped: SkippedDevice[] = [];
  const seenAliases: string[] = [];

  for (const device of devices.items) {
    if (device.kind !== "obj") continue;
    const rawId = textMember(device, "id");
    const alias = sanitizeToken(rawId);
    if (alias === "") {
      skipped.push(new SkippedDevice(rawId === "" ? "(unnamed)" : rawId, "missing/invalid id"));
      continue;
    }

    let hostname = textMember(device, "mgmtIp");
    if (hostname === "") {
      const list = device.get("mgmtIps");
      if (list !== null && list.kind === "arr" && list.items.length > 0) {
        hostname = list.items[0].kind === "str" ? list.items[0].s.trim() : "";
      }
    }
    if (hostname === "") {
      skipped.push(new SkippedDevice(alias, "no management IP (VM not running / no DHCP lease)"));
      continue;
    }
    if (!SAFE_HOSTNAME.test(hostname)) {
      skipped.push(new SkippedDevice(alias, `invalid management IP/host: ${hostname}`));
      continue;
    }
    // OpenSSH's first matching Host value wins, while a Map assignment would
    // make the last duplicate password win. Refuse the duplicate instead of
    // ever pairing one device's address with another device's credential.
    if (seenAliases.includes(alias)) {
      skipped.push(new SkippedDevice(alias, "duplicate alias"));
      continue;
    }
    seenAliases.push(alias);

    const lines: string[] = [`Host ${alias}`, `    HostName ${hostname}`];

    const user = sanitizeToken(textMember(device, "sshUser"));
    if (user !== "") lines.push(`    User ${user}`);

    let port = parseIntPrefix(textMember(device, "sshPort"), DEFAULT_PORT);
    if (port <= 0 || port > 65535) port = DEFAULT_PORT;
    lines.push(`    Port ${port}`);

    const driver = sanitizeToken(textMember(device, "driver"));
    if (driver !== "") lines.push(`    #nat-driver ${driver}`);

    const password = stringMember(device, "password");
    const identity = sanitizePath(textMember(device, "sshIdentityFile"));
    if (identity !== "") {
      // IdentitiesOnly keeps agent keys from being offered ahead of the
      // device's own key: several network OSes drop the connection after a few
      // failed public-key attempts.
      lines.push(`    IdentityFile ${identity}`);
      lines.push(`    IdentitiesOnly yes`);
    } else if (password !== "") {
      lines.push(`    IdentitiesOnly yes`);
      // IdentitiesOnly alone still lets OpenSSH try its default ~/.ssh/id_*
      // keys. Disabling public-key auth reaches the inventory password before a
      // device with a low MaxAuthTries disconnects.
      lines.push(`    PubkeyAuthentication no`);
    }

    blocks.push(lines.join("\n"));
    if (password !== "") passwordByHost.set(alias, password);
  }

  const text = `${blocks.join("\n\n")}\n`;
  const inventory = new Inventory(parseSshConfigText(text, ""), resolved);
  inventory.passwordByHost = passwordByHost;
  inventory.skipped = skipped;
  inventory.deviceCount = blocks.length;
  inventory.syntheticText = text;
  return inventory;
}
