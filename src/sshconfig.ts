/**
 * An OpenSSH client-config reader.
 *
 * nat needs two things from `~/.ssh/config` that the `ssh` binary cannot hand
 * back: the list of host aliases (`ssh -G` resolves one host, it cannot
 * enumerate them) and the per-host `#nat-driver` comment. Connections are made
 * by ssh against the same file, so this reader follows OpenSSH's rules:
 *
 *  - the first obtained value for each keyword wins (a later block cannot
 *    override an earlier one);
 *  - `Host` patterns support `*`, `?` and `!negation`;
 *  - `Include` is inlined at its position, globbed, relative paths under ~/.ssh;
 *  - `Key Value`, `Key=Value` and quoted values are all accepted.
 *
 * `Match` blocks are honoured for the `all`, `host` and `originalhost` criteria.
 * A `Match` whose criteria nat cannot evaluate offline (`exec`, `localuser`, …)
 * is skipped rather than guessed at — ssh still applies it when connecting.
 *
 * The driver lives in a comment, `#nat-driver sonic`, because OpenSSH rejects
 * a config file containing a keyword it does not know.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import { globToRegExp } from "./text.ts";

/** The resolved key a `#nat-driver` comment is stored under; no real keyword can collide with it. */
export const DRIVER_KEY = "#nat-driver";

const BLOCK_HOST = "host";
const BLOCK_MATCH = "match";

class ConfigEntry {
  /** Lower-cased keyword. */
  key: string;
  value: string;

  constructor(keyword: string, value: string) {
    this.key = keyword.toLowerCase();
    this.value = value;
  }
}

class ConfigBlock {
  kind: string;
  /** Patterns from a `Host` block. */
  patterns: string[];
  /** `Match host` patterns (matched against HostName resolved so far). */
  matchHostPatterns: string[];
  /** `Match originalhost` patterns (matched against the CLI alias). */
  matchOriginalPatterns: string[];
  /** True for `Match all` and for the implicit block before any Host line. */
  matchesEverything: boolean;
  /** True when a Match block carries criteria nat cannot evaluate offline. */
  unevaluable: boolean;
  entries: ConfigEntry[];

  constructor(kind: string) {
    this.kind = kind;
    this.patterns = [];
    this.matchHostPatterns = [];
    this.matchOriginalPatterns = [];
    this.matchesEverything = false;
    this.unevaluable = false;
    this.entries = [];
  }
}

/** A parsed ssh client config, ready to enumerate and resolve. */
export class SshConfig {
  /** The file this was read from ("" for text parsed in memory). */
  path: string;
  blocks: ConfigBlock[];

  constructor(path: string) {
    this.path = path;
    this.blocks = [];
  }
}

function splitTokens(value: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote = "";
  let escaped = false;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value.charAt(i);
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote !== "") {
      if (ch === quote) quote = "";
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current !== "") {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (escaped) current += "\\";
  if (current !== "") tokens.push(current);
  return tokens;
}

/** Remove an OpenSSH inline comment, preserving # inside a token or quotes. */
function stripInlineComment(value: string): string {
  let quote = "";
  let escaped = false;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value.charAt(i);
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote !== "") {
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "#" && (i === 0 || /\s/.test(value.charAt(i - 1)))) return value.slice(0, i);
  }
  return value;
}

/** Strip one layer of matching quotes from a value. */
function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed.charAt(0);
    const last = trimmed.charAt(trimmed.length - 1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, trimmed.length - 1);
    }
  }
  return trimmed;
}

/**
 * Split a config line into keyword and value. OpenSSH accepts `Key Value`,
 * `Key=Value` and `Key = Value`.
 */
function splitKeyword(line: string): string[] {
  const trimmed = line.trim();
  const m = trimmed.match(/^([A-Za-z0-9_-]+)\s*(?:=|\s)\s*(.*)$/);
  if (m === null) return [trimmed, ""];
  return [m[1], m[2].trim()];
}

/** The value of a `#nat-driver <os>` comment, or "" for any other comment. */
function driverComment(line: string): string {
  const m = line.trim().match(/^#nat-driver\s+(\S.*)$/i);
  return m === null ? "" : unquote(stripInlineComment(m[1]));
}

/** Expand an `Include` value into concrete, existing file paths. */
function expandInclude(value: string, baseDir: string): string[] {
  const out: string[] = [];
  for (const rawToken of splitTokens(value)) {
    let token = unquote(rawToken);
    if (token === "~") token = homedir();
    else if (token.startsWith("~/")) token = join(homedir(), token.slice(2));
    const absolute = isAbsolute(token) ? token : join(baseDir, token);
    if (!absolute.includes("*") && !absolute.includes("?")) {
      if (existsSync(absolute)) out.push(absolute);
      continue;
    }
    const dir = dirname(absolute);
    const pattern = absolute.slice(dir.length + 1);
    if (!existsSync(dir)) continue;
    const matcher = globToRegExp(pattern);
    const names = readdirSync(dir);
    names.sort();
    for (const name of names) {
      if (!matcher.test(name)) continue;
      const candidate = join(dir, name);
      try {
        if (statSync(candidate).isFile()) out.push(candidate);
      } catch (err) {
        // A dangling symlink in ~/.ssh/config.d is not an error for ssh either.
      }
    }
  }
  return out;
}

/** Which Match criteria nat can decide without a live connection. */
function classifyMatch(value: string, block: ConfigBlock): void {
  const parts = splitTokens(value);
  let index = 0;
  while (index < parts.length) {
    const criterion = parts[index].toLowerCase();
    if (criterion === "all" || criterion === "final") {
      // `final` is true on ssh's unconditional final configuration pass. nat
      // does one effective pass, so both are neutral/true criteria here.
      block.matchesEverything = true;
      index += 1;
      continue;
    }
    if (criterion === "canonical") {
      // Whether canonicalization happened depends on DNS and ssh's second pass.
      block.unevaluable = true;
      index += 1;
      continue;
    }
    if (criterion === "host" || criterion === "originalhost") {
      index += 1;
      if (index >= parts.length) {
        block.unevaluable = true;
        continue;
      }
      const target = criterion === "host" ? block.matchHostPatterns : block.matchOriginalPatterns;
      for (const pattern of parts[index].split(",")) {
        if (pattern !== "") target.push(pattern);
      }
      index += 1;
      continue;
    }
    // user / localuser / exec / address / tagged / … need context nat does not
    // have offline. The block still applies when ssh connects; nat skips it.
    block.unevaluable = true;
    index += 2;
  }
}

/**
 * Parse `text` into `config`, appending blocks. Returns the block that is open
 * when the text ends — an `Include` leaves its file's last block in effect, the
 * same way OpenSSH's shared activation flag does.
 */
function parseInto(
  config: SshConfig,
  text: string,
  baseDir: string,
  open: ConfigBlock,
  depth: number,
  activeFiles: string[],
): ConfigBlock {
  if (depth > 16) return open;
  let current = open;

  const lines = text.split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();
    if (trimmed === "") continue;

    if (trimmed.startsWith("#")) {
      const driver = driverComment(trimmed);
      if (driver !== "") current.entries.push(new ConfigEntry(DRIVER_KEY, driver));
      continue;
    }

    const line = stripInlineComment(rawLine).trim();
    if (line === "") continue;

    const pair = splitKeyword(line);
    const keyword = pair[0];
    const rawValue = pair[1];
    const value = unquote(rawValue);
    const key = keyword.toLowerCase();

    if (key === "host") {
      current = new ConfigBlock(BLOCK_HOST);
      for (const pattern of splitTokens(rawValue)) current.patterns.push(pattern);
      config.blocks.push(current);
      continue;
    }
    if (key === "match") {
      current = new ConfigBlock(BLOCK_MATCH);
      classifyMatch(rawValue, current);
      config.blocks.push(current);
      continue;
    }
    if (key === "include") {
      for (const included of expandInclude(rawValue, baseDir)) {
        // The same file may be included at several positions and is processed
        // each time; only a file already on this recursion path is a cycle.
        // De-duplicating across the whole parse would change first-wins order.
        if (activeFiles.includes(included)) continue;
        let contents = "";
        try {
          contents = readFileSync(included, "utf8");
        } catch (err) {
          continue;
        }
        activeFiles.push(included);
        current = parseInto(config, contents, baseDir, current, depth + 1, activeFiles);
        activeFiles.pop();
      }
      continue;
    }

    current.entries.push(new ConfigEntry(keyword, value));
  }
  return current;
}

function newConfig(path: string, text: string, baseDir: string, label: string): SshConfig {
  const config = new SshConfig(path);
  // Keywords before the first Host/Match line apply to every host.
  const preamble = new ConfigBlock(BLOCK_HOST);
  preamble.matchesEverything = true;
  config.blocks.push(preamble);
  parseInto(config, text, baseDir, preamble, 0, [label]);
  return config;
}

/** Parse ssh-config text that is not backed by a file (tests, JSON inventories). */
export function parseSshConfigText(text: string, path: string): SshConfig {
  // OpenSSH resolves every relative Include in a user config under ~/.ssh,
  // including when the top-level file came from `ssh -F /some/other/path`.
  const baseDir = join(homedir(), ".ssh");
  return newConfig(path, text, baseDir, path === "" ? "(memory)" : path);
}

/** Read and parse an ssh client config file, following `Include`. */
export function parseSshConfigFile(path: string): SshConfig {
  return newConfig(path, readFileSync(path, "utf8"), join(homedir(), ".ssh"), path);
}

/** One OpenSSH pattern-list, including `!negation`. */
function patternListMatches(patterns: string[], value: string, ignoreCase: boolean): boolean {
  if (patterns.length === 0) return false;
  const candidate = ignoreCase ? value.toLowerCase() : value;
  let positive = false;
  for (const raw of patterns) {
    const negated = raw.startsWith("!");
    const body = negated ? raw.slice(1) : raw;
    const pattern = ignoreCase ? body.toLowerCase() : body;
    if (!globToRegExp(pattern).test(candidate)) continue;
    if (negated) return false;
    positive = true;
  }
  return positive;
}

/** True when the current host state satisfies a Host or Match block. */
function blockMatches(block: ConfigBlock, alias: string, hostname: string): boolean {
  if (block.unevaluable) return false;
  if (block.kind === BLOCK_HOST) {
    if (block.patterns.length === 0) return block.matchesEverything;
    return patternListMatches(block.patterns, alias, false);
  }

  let hasCriterion = block.matchesEverything;
  if (block.matchOriginalPatterns.length > 0) {
    hasCriterion = true;
    if (!patternListMatches(block.matchOriginalPatterns, alias, true)) return false;
  }
  if (block.matchHostPatterns.length > 0) {
    hasCriterion = true;
    if (!patternListMatches(block.matchHostPatterns, hostname, true)) return false;
  }
  return hasCriterion;
}

/**
 * Every literal host alias the config declares, in file order. Wildcard-only
 * patterns and negations name no single host, so they are skipped — this is the
 * list `nat inventory list` prints and `--all` expands to.
 */
export function listHostAliases(config: SshConfig): string[] {
  const aliases: string[] = [];
  for (const block of config.blocks) {
    if (block.kind !== BLOCK_HOST) continue;
    for (const pattern of block.patterns) {
      if (pattern === "" || pattern === "*") continue;
      if (pattern.includes("*") || pattern.includes("?") || pattern.startsWith("!")) continue;
      if (!aliases.includes(pattern)) aliases.push(pattern);
    }
  }
  return aliases;
}

/** Every keyword that applies to `alias`, first value wins. */
export function computeHost(config: SshConfig, alias: string): Map<string, string> {
  const resolved = new Map<string, string>();
  let hostname = alias;
  for (const block of config.blocks) {
    if (!blockMatches(block, alias, hostname)) continue;
    for (const entry of block.entries) {
      if (resolved.has(entry.key)) continue;
      resolved.set(entry.key, entry.value);
      // `Match host` uses the HostName obtained before that Match block,
      // whereas `Match originalhost` always sees the CLI alias.
      if (entry.key === "hostname") hostname = entry.value;
    }
  }
  return resolved;
}

export function keywordValue(resolved: Map<string, string>, key: string, fallback: string): string {
  const value = resolved.get(key);
  return value === undefined ? fallback : value;
}
