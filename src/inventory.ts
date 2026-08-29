/**
 * src/inventory.ts — the host inventory.
 *
 * Two sources produce the same shape: the user's ssh client config, and a JSON
 * lab inventory (the schema vmlab's `/api/labs/:id/inventory.json` emits). The
 * JSON source is translated into a synthetic ssh config so selection,
 * resolution and the ssh transport all work against one representation — and so
 * the generated file can be handed to `ssh -F` unchanged.
 */

import { existsSync, readFileSync } from "node:fs";

import { Json, jsonAsString, parseJson } from "./json.ts";
import { DEFAULT_PORT, HostConfig } from "./models.ts";
import { expandUser, defaultSshConfigPath } from "./paths.ts";
import {
  SshConfig,
  computeHost,
  keywordValue,
  keywordValues,
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
  source: string;
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
    this.source = "ssh-config";
    this.syntheticText = "";
  }
}

/** Read the ssh client config (default `~/.ssh/config`) as the inventory. */
export function loadInventory(configPath: string): Inventory {
  const resolved = configPath === "" ? defaultSshConfigPath() : expandUser(configPath);
  if (!existsSync(resolved)) {
    throw new InventoryError(`SSH config not found: ${resolved}`);
  }
  return new Inventory(parseSshConfigFile(resolved), resolved);
}

/** Build an inventory from ssh-config text held in memory (tests). */
export function inventoryFromText(text: string, label: string): Inventory {
  return new Inventory(parseSshConfigText(text, ""), label);
}

/** True when a host token is a glob pattern rather than a literal name. */
export function isHostPattern(token: string): boolean {
  return isGlob(token);
}

/** The resolved connection details for one alias. */
export function resolveHost(config: SshConfig, alias: string): HostConfig {
  const resolved = computeHost(config, alias);
  const host = new HostConfig(alias);
  host.hostname = keywordValue(resolved, "hostname", alias);
  host.user = keywordValue(resolved, "user", "");
  host.port = parseIntPrefix(keywordValue(resolved, "port", ""), DEFAULT_PORT);
  if (host.port <= 0 || host.port > 65535) host.port = DEFAULT_PORT;
  for (const file of keywordValues(resolved, "identityfile")) {
    if (file !== "" && file.toLowerCase() !== "none") host.identityFiles.push(file);
  }
  host.identitiesOnly = keywordValue(resolved, "identitiesonly", "").toLowerCase() === "yes";
  host.proxyJump = keywordValue(resolved, "proxyjump", "");
  if (host.proxyJump.toLowerCase() === "none") host.proxyJump = "";

  // The driver keyword, in the order the docs list it: #nat-driver wins over
  // the older #nat-os / NatOs spelling only by appearing first in the file, so
  // all four names are read the same way.
  let driver = keywordValue(resolved, "nat-driver", "");
  if (driver === "") driver = keywordValue(resolved, "driver", "");
  if (driver === "") driver = keywordValue(resolved, "nat-os", "");
  if (driver === "") driver = keywordValue(resolved, "natos", "");
  host.targetOs = driver;
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

/* --------------------------- JSON inventory source ------------------------ */

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

/** The first non-empty string among `keys`, as a raw (unvalidated) value. */
function firstString(device: Json, keys: string[]): string {
  for (const key of keys) {
    const value = device.get(key);
    if (value === null) continue;
    const text = jsonAsString(value, "").trim();
    if (text !== "") return text;
  }
  return "";
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

  let devices: Json | null = null;
  if (root.kind === "arr") devices = root;
  else if (root.kind === "obj") {
    const listed = root.get("devices");
    if (listed !== null && listed.kind === "arr") devices = listed;
  }
  if (devices === null) {
    throw new InventoryError("inventory file must be an object with a `devices` array (vmlab inventory schema)");
  }

  const blocks: string[] = [];
  const passwordByHost = new Map<string, string>();
  const skipped: SkippedDevice[] = [];
  const seenAliases: string[] = [];

  for (const device of devices.items) {
    if (device.kind !== "obj") continue;
    const rawId = firstString(device, ["id", "sshAlias", "name"]);
    const alias = sanitizeToken(firstString(device, ["sshAlias", "id", "name"]));
    if (alias === "") {
      skipped.push(new SkippedDevice(rawId === "" ? "(unnamed)" : rawId, "missing/invalid alias"));
      continue;
    }

    let hostname = firstString(device, ["mgmtIp"]);
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

    const user = sanitizeToken(firstString(device, ["sshUser", "user"]));
    if (user !== "") lines.push(`    User ${user}`);

    let port = parseIntPrefix(firstString(device, ["sshPort", "port"]), DEFAULT_PORT);
    if (port <= 0 || port > 65535) port = DEFAULT_PORT;
    lines.push(`    Port ${port}`);

    const driver = sanitizeToken(firstString(device, ["driver", "targetOs", "os"]));
    if (driver !== "") lines.push(`    #nat-driver ${driver}`);

    const password = stringMember(device, "password");
    const identity = sanitizePath(firstString(device, ["sshIdentityFile", "identityFile", "sshKey"]));
    if (identity !== "") {
      // IdentitiesOnly keeps agent keys from being offered ahead of the
      // device's own key: several network OSes drop the connection after a few
      // failed public-key attempts.
      lines.push(`    IdentityFile ${identity}`);
      lines.push(`    IdentitiesOnly yes`);
    } else if (password !== "") {
      lines.push(`    IdentitiesOnly yes`);
      // OpenSSH still considers its default ~/.ssh/id_* files with only
      // IdentitiesOnly=yes. The Bun transport offered no keys in this branch,
      // so disable public-key auth explicitly and reach the inventory password
      // before devices with a low MaxAuthTries disconnect.
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
  inventory.source = root.kind === "obj" ? stringMember(root, "source") || "json" : "json";
  inventory.syntheticText = text;
  return inventory;
}
