/**
 * src/parse-util.ts — the shared toolkit the driver parsers are built from.
 *
 * Every parser turns a command transcript into a `Json` tree. The helpers here
 * are the pieces they all reuse: dropping login noise, finding a table's dashed
 * separator, splitting a row (whitespace-aligned or `tabulate` grid form), and
 * collecting `Key : Value` blocks.
 */

import { Json, jarr, jnull, jnum, jobj, jstr } from "./json.ts";
import { splitLines } from "./text.ts";

/**
 * Non-empty, right-trimmed lines with the login banner and ssh's own
 * known-hosts notice dropped — noise every driver sees.
 */
export function deviceLines(raw: string): string[] {
  const out: string[] = [];
  for (const line of splitLines(raw)) {
    const trimmed = line.trimEnd();
    if (trimmed.trim() === "") continue;
    if (/^Debian GNU\/Linux/.test(trimmed)) continue;
    if (/^Warning: Permanently added/.test(trimmed)) continue;
    out.push(trimmed);
  }
  return out;
}

/** Index of the `----  ----` separator row in a `show` table, or -1. */
export function dashRowIndex(lines: string[]): number {
  for (let i = 0; i < lines.length; i += 1) {
    if (/^[\s-]*-{3,}[\s-]*$/.test(lines[i]) && lines[i].includes("-")) return i;
  }
  return -1;
}

/**
 * Split one table row into trimmed cells, handling both render styles: plain
 * whitespace-aligned columns (`Vlan10   10010`) and the `tabulate` grid form
 * (`| Vlan10 | 10010 |`). Grid borders reduce to cells the callers reject.
 */
export function splitTableRow(line: string): string[] {
  if (line.includes("|")) {
    const trimmed = line.replace(/^\s*\|/, "").replace(/\|\s*$/, "");
    const cells: string[] = [];
    for (const cell of trimmed.split("|")) cells.push(cell.trim());
    return cells;
  }
  const stripped = line.trim();
  return stripped === "" ? [] : stripped.split(/\s+/);
}

/** Index of the first token at or after `from` matching `pattern`, or -1. */
export function findToken(list: string[], pattern: RegExp, from: number): number {
  for (let i = from; i < list.length; i += 1) {
    if (pattern.test(list[i])) return i;
  }
  return -1;
}

/** The first token matching `pattern`, or "". */
export function firstToken(list: string[], pattern: RegExp): string {
  const index = findToken(list, pattern, 0);
  return index < 0 ? "" : list[index];
}

/** `Key : Value` pairs from a block of lines, as an object node. */
export function kvPairs(lines: string[]): Json {
  const out = jobj();
  for (const line of lines) {
    const m = line.match(/^\s*([A-Za-z][A-Za-z0-9 .,()/_-]*?)\s*:\s*(.*\S)\s*$/);
    if (m === null) continue;
    const key = m[1].trim();
    if (!out.has(key)) out.setStr(key, m[2].trim());
  }
  return out;
}

/** `"Yes"`/`"No"` → a boolean node; anything else → absent. */
export function boolFieldFrom(fields: Json, key: string): boolean | null {
  const value = fields.str(key, "");
  if (/^yes$/i.test(value)) return true;
  if (/^no$/i.test(value)) return false;
  return null;
}

/** A numeric field, or null when it is missing or not a number. */
export function numFieldFrom(fields: Json, key: string): number | null {
  const value = fields.str(key, "").trim();
  if (value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** A finite number, or null. */
export function toNumOrNull(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Turn a header token into a safe object key (`Use%` → `use`). */
export function headerKey(header: string): string {
  return header
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+/, "")
    .replace(/_+$/, "");
}

/** Split a line into at most `count` fields; the last keeps the remainder. */
export function splitColumns(line: string, count: number): string[] {
  const parts: string[] = [];
  let rest = line.trim();
  for (let index = 0; index < count - 1; index += 1) {
    const m = rest.match(/^(\S+)\s+([\s\S]*)$/);
    if (m === null) break;
    parts.push(m[1]);
    rest = m[2];
  }
  if (rest !== "") parts.push(rest);
  return parts;
}

/** An object node with a `kind` tag — the self-describing envelope. */
export function kindObject(kind: string): Json {
  return jobj().setStr("kind", kind);
}

/** `{ kind, <name>: [...] }` — the shape the vendor list parsers return. */
export function kindList(kind: string, name: string, items: Json[]): Json {
  const node = kindObject(kind);
  const list = jarr();
  for (const item of items) list.push(item);
  node.set(name, list);
  return node;
}

/** `{ <name>: [...], count }` — the untagged shape the generic parsers return. */
export function plainList(name: string, items: Json[]): Json {
  const node = jobj();
  const list = jarr();
  for (const item of items) list.push(item);
  node.set(name, list);
  node.setNum("count", items.length);
  return node;
}

/** A string array node. */
export function stringList(values: string[]): Json {
  const list = jarr();
  for (const value of values) list.push(jstr(value));
  return list;
}

/** The literal `null` node, for fields that are reported but absent. */
export function nullNode(): Json {
  return jnull();
}

/** A number node. */
export function numberNode(value: number): Json {
  return jnum(value);
}
