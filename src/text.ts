/** Small text helpers shared across the toolkit. */

/** Last characters that make a line look like a device or shell prompt. */
export const PROMPT_SUFFIXES = ["#", ">", "$", "%"];

/** Split on any line ending (CRLF, CR, LF) — device transcripts mix all three. */
export function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/** Collapse runs of internal whitespace so command keys match regardless of spacing. */
export function normalizeSpace(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

/** Whitespace-separated tokens of a line, with no empty entries. */
export function tokens(line: string): string[] {
  const trimmed = line.trim();
  if (trimmed === "") return [];
  return trimmed.split(/\s+/);
}

const REGEXP_SPECIALS = ".*+?^${}()|[]\\/";

/**
 * Compile a shell-style glob into an anchored RegExp. `*` matches any run and
 * `?` matches one character; everything else is literal.
 */
export function globToRegExp(pattern: string): RegExp {
  let body = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern.charAt(i);
    if (ch === "*") body += ".*";
    else if (ch === "?") body += ".";
    else if (REGEXP_SPECIALS.includes(ch)) body += "\\" + ch;
    else body += ch;
  }
  return new RegExp(`^${body}$`);
}

/** True when a token uses glob wildcards rather than naming a literal host. */
export function isGlob(token: string): boolean {
  return token.includes("*") || token.includes("?");
}

/**
 * `parseInt(value, 10)` — the leading-integer prefix of `value`, or `fallback`
 * when it has none. `Number.parseInt` runs only in the dynamic engine, and
 * `Number("22x")` is NaN where `parseInt("22x")` is 22, so the prefix scan is
 * explicit.
 */
export function parseIntPrefix(value: string, fallback: number): number {
  const text = value.trim();
  let index = 0;
  let sign = 1;
  if (text.startsWith("-")) {
    sign = -1;
    index = 1;
  } else if (text.startsWith("+")) {
    index = 1;
  }
  let digits = "";
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code < 48 || code > 57) break;
    digits += text.charAt(index);
    index += 1;
  }
  if (digits === "") return fallback;
  const parsed = Number(digits);
  return Number.isFinite(parsed) ? sign * parsed : fallback;
}

/** Wrap `value` in single quotes for /bin/sh, escaping embedded quotes. */
export function shellQuote(value: string): string {
  return "'" + value.split("'").join("'\\''") + "'";
}

/** Indent every line of `text` by `spaces`, leaving blank lines untouched. */
export function indentLines(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  const out: string[] = [];
  for (const line of splitLines(text)) out.push(line === "" ? line : pad + line);
  return out.join("\n");
}

/** Drop leading and trailing blank lines (interior blank lines survive). */
export function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === "") start += 1;
  while (end > start && lines[end - 1].trim() === "") end -= 1;
  return lines.slice(start, end);
}

/** The last line with content, or `null` when there is none. */
export function lastNonEmptyLine(text: string): string | null {
  const lines = splitLines(text);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const stripped = lines[i].trim();
    if (stripped !== "") return stripped;
  }
  return null;
}

/**
 * One capture group's value, "" when the group did not participate.
 *
 * An unmatched optional group reads as `undefined` under Node and as "" in a
 * compiled binary, and an out-of-range index is a hard trap there rather than
 * `undefined`. Every group read goes through here so both worlds answer the
 * same, and an index past the end is simply absent.
 *
 * A group that matched the empty string is therefore indistinguishable from one
 * that did not match — no parser here gives an empty capture its own meaning.
 */
export function group(match: RegExpMatchArray, index: number): string {
  if (index < 0 || index >= match.length) return "";
  const value = match[index];
  return value === undefined ? "" : value;
}

/** True when the capture group participated and captured something. */
export function hasGroup(match: RegExpMatchArray, index: number): boolean {
  return group(match, index) !== "";
}
