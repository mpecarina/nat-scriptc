/**
 * src/parser-packs.ts — custom parsers without a JavaScript engine.
 *
 * The Bun-era tool loaded `--parsers ./pack.mjs`, an ES module of parser
 * functions. A statically compiled binary has no engine to run that in, so the
 * same extension point is offered two ways, both of which a compiled nat can
 * execute:
 *
 *   --parsers <pack.json>   a declarative pack: regex field and row rules
 *   --parser-cmd <program>  a filter program: JSON in on stdin, JSON out
 *
 * Between them they cover what the module packs were used for — pulling named
 * fields out of a `show` transcript, turning repeating lines into rows, and (in
 * the general case) running arbitrary code in any language.
 *
 * Pack format:
 *
 *   {
 *     "sonic": {
 *       "show version": {
 *         "kind": "sonic.version",
 *         "fields": { "version": { "pattern": "Version:\\s*(\\S+)" } }
 *       },
 *       "show ip route*": {
 *         "kind": "sonic.ipRoute",
 *         "list": "routes",
 *         "skip": ["^Codes:"],
 *         "row": {
 *           "pattern": "^(\\S+/\\d+)\\s+via\\s+(\\S+)$",
 *           "fields": [{ "name": "prefix" }, { "name": "nextHop" }]
 *         },
 *         // a field may also carry "type": number|boolean and
 *         // "split": "<regex>", which turns one capture into an array
 *         "count": true
 *       },
 *       "df*": { "table": true },
 *       "*": { "keyValue": true }
 *     }
 *   }
 */

import { existsSync, readFileSync } from "node:fs";

import { Json, jarr, jbool, jnull, jnum, jobj, jstr, parseJson, renderJson } from "./json.ts";
import { ParserContext } from "./models.ts";
import { ParserTable } from "./drivers.ts";
import type { ParserFn } from "./drivers.ts";
import { parseKeyValue, parseTable } from "./parsers-generic.ts";
import { runProcessSync } from "./process.ts";
import { expandUser } from "./paths.ts";
import { group, hasGroup, splitLines } from "./text.ts";

export class ParserPackError extends Error {}

/** A custom parser must not be able to stall an entire multi-host run forever. */
export const PARSER_COMMAND_TIMEOUT_MS = 30_000;

const TYPE_STRING = "string";
const TYPE_NUMBER = "number";
const TYPE_BOOLEAN = "boolean";

/** One named capture in a rule. */
class FieldSpec {
  name: string;
  pattern: RegExp;
  group: number;
  type: string;
  /** When set, the capture splits on this pattern into an array. */
  split: RegExp | null;

  constructor(name: string, pattern: RegExp, group: number, type: string, split: RegExp | null) {
    this.name = name;
    this.pattern = pattern;
    this.group = group;
    this.type = type;
    this.split = split;
  }
}

/** One column of a row rule; the row's own pattern does the capturing. */
class ColumnSpec {
  name: string;
  group: number;
  type: string;
  /** When set, the capture splits on this pattern into an array. */
  split: RegExp | null;

  constructor(name: string, group: number, type: string, split: RegExp | null) {
    this.name = name;
    this.group = group;
    this.type = type;
    this.split = split;
  }
}

/** A compiled rule from a declarative pack. */
class PackRule {
  kind: string;
  useKeyValue: boolean;
  useTable: boolean;
  emitLines: boolean;
  fields: FieldSpec[];
  listName: string;
  rowPattern: RegExp | null;
  columns: ColumnSpec[];
  skip: RegExp[];
  count: boolean;

  constructor() {
    this.kind = "";
    this.useKeyValue = false;
    this.useTable = false;
    this.emitLines = false;
    this.fields = [];
    this.listName = "";
    this.rowPattern = null;
    this.columns = [];
    this.skip = [];
    this.count = false;
  }
}

function compileRegExp(source: string, flags: string, where: string): RegExp {
  // Field/row rules depend on capture groups and are reused across commands.
  // JavaScript's global match drops captures, while sticky regexes retain a
  // mutable lastIndex; either flag would make a valid pack parse intermittently.
  if (flags.includes("g") || flags.includes("y")) {
    throw new ParserPackError(`${where}: flags 'g' and 'y' are not supported for capture rules`);
  }
  try {
    return new RegExp(source, flags);
  } catch (err) {
    const detail = err instanceof Error ? err.message : "invalid pattern";
    throw new ParserPackError(`${where}: ${detail}`);
  }
}

function readType(node: Json): string {
  const value = node.str("type", TYPE_STRING).toLowerCase();
  if (value === TYPE_NUMBER || value === TYPE_BOOLEAN) return value;
  return TYPE_STRING;
}

/** A capture split into an array of typed values (an address or member list). */
function splitValue(raw: string, type: string, separator: RegExp): Json {
  const list = jarr();
  const trimmed = raw.trim();
  if (trimmed === "") return list;
  for (const piece of trimmed.split(separator)) {
    if (piece !== "") list.push(typedValue(piece, type));
  }
  return list;
}

function typedValue(raw: string, type: string): Json {
  if (type === TYPE_NUMBER) {
    const parsed = Number(raw.trim());
    return Number.isFinite(parsed) ? jnum(parsed) : jnull();
  }
  if (type === TYPE_BOOLEAN) {
    const normalized = raw.trim().toLowerCase();
    return jbool(normalized === "true" || normalized === "yes" || normalized === "up" || normalized === "1");
  }
  return jstr(raw.trim());
}

function compileRule(spec: Json, where: string): PackRule {
  const rule = new PackRule();
  rule.kind = spec.str("kind", "");
  rule.useKeyValue = spec.bool("keyValue", false);
  rule.useTable = spec.bool("table", false);
  rule.emitLines = spec.bool("lines", false);
  rule.count = spec.bool("count", false);
  rule.listName = spec.str("list", "");

  const fields = spec.get("fields");
  if (fields !== null && fields.kind === "obj") {
    for (let i = 0; i < fields.keys.length; i += 1) {
      const name = fields.keys[i];
      const field = fields.vals[i];
      const pattern = field.kind === "str" ? field.s : field.str("pattern", "");
      if (pattern === "") throw new ParserPackError(`${where}: field '${name}' has no pattern`);
      const flags = field.kind === "str" ? "" : field.str("flags", "");
      const groupIndex = field.kind === "str" ? 1 : Math.trunc(field.num("group", 1));
      const type = field.kind === "str" ? TYPE_STRING : readType(field);
      const split = field.kind === "str" ? "" : field.str("split", "");
      rule.fields.push(
        new FieldSpec(
          name,
          compileRegExp(pattern, flags, `${where}.fields.${name}`),
          groupIndex,
          type,
          split === "" ? null : compileRegExp(split, "", `${where}.fields.${name}.split`),
        ),
      );
    }
  }

  const row = spec.get("row");
  if (row !== null && row.kind === "obj") {
    const pattern = row.str("pattern", "");
    if (pattern === "") throw new ParserPackError(`${where}.row: no pattern`);
    rule.rowPattern = compileRegExp(pattern, row.str("flags", ""), `${where}.row`);
    const columns = row.get("fields");
    if (columns !== null && columns.kind === "arr") {
      for (let i = 0; i < columns.items.length; i += 1) {
        const column = columns.items[i];
        const name = column.kind === "str" ? column.s : column.str("name", "");
        if (name === "") throw new ParserPackError(`${where}.row.fields[${i}]: no name`);
        const groupIndex = column.kind === "str" ? i + 1 : Math.trunc(column.num("group", i + 1));
        const type = column.kind === "str" ? TYPE_STRING : readType(column);
        const split = column.kind === "str" ? "" : column.str("split", "");
        rule.columns.push(
          new ColumnSpec(
            name,
            groupIndex,
            type,
            split === "" ? null : compileRegExp(split, "", `${where}.row.fields[${i}].split`),
          ),
        );
      }
    }
    if (rule.listName === "") rule.listName = "rows";
  }

  const skip = spec.get("skip");
  if (skip !== null && skip.kind === "arr") {
    for (let i = 0; i < skip.items.length; i += 1) {
      const entry = skip.items[i];
      if (entry.kind !== "str") continue;
      rule.skip.push(compileRegExp(entry.s, "", `${where}.skip[${i}]`));
    }
  }

  return rule;
}

/** Turn a compiled rule into the parser the table calls. */
function ruleParser(rule: PackRule): ParserFn {
  return (raw: string, ctx: ParserContext): Json => {
    if (rule.useTable) return parseTable(raw, ctx);
    if (rule.useKeyValue) return parseKeyValue(raw, ctx);

    const node = jobj();
    if (rule.kind !== "") node.setStr("kind", rule.kind);

    for (const field of rule.fields) {
      const m = raw.match(field.pattern);
      if (m === null) continue;
      if (!hasGroup(m, field.group)) continue;
      const captured = group(m, field.group);
      node.set(
        field.name,
        field.split === null ? typedValue(captured, field.type) : splitValue(captured, field.type, field.split),
      );
    }

    if (rule.rowPattern !== null) {
      const rows = jarr();
      for (const line of splitLines(raw)) {
        if (line.trim() === "") continue;
        let skipped = false;
        for (const pattern of rule.skip) {
          if (pattern.test(line)) {
            skipped = true;
            break;
          }
        }
        if (skipped) continue;
        const m = line.match(rule.rowPattern);
        if (m === null) continue;
        const row = jobj();
        if (rule.columns.length === 0) {
          for (let g = 1; g < m.length; g += 1) {
            row.set(`group${g}`, hasGroup(m, g) ? jstr(group(m, g)) : jnull());
          }
        } else {
          for (const column of rule.columns) {
            if (!hasGroup(m, column.group)) {
              row.set(column.name, column.split === null ? jnull() : jarr());
              continue;
            }
            const captured = group(m, column.group);
            row.set(
              column.name,
              column.split === null
                ? typedValue(captured, column.type)
                : splitValue(captured, column.type, column.split),
            );
          }
        }
        rows.push(row);
      }
      node.set(rule.listName, rows);
      if (rule.count) node.setNum("count", rows.items.length);
    }

    if (rule.emitLines) {
      const lines = jarr();
      for (const line of splitLines(raw)) {
        if (line.trim() !== "") lines.push(jstr(line));
      }
      node.set("lines", lines);
    }

    return node;
  };
}

/** Compile a declarative pack (already parsed) into a parser table. */
export function compileParserPack(root: Json, label: string): ParserTable {
  if (root.kind !== "obj") {
    throw new ParserPackError(`${label}: a parser pack must be an object keyed by driver`);
  }
  const table = new ParserTable();
  for (let d = 0; d < root.keys.length; d += 1) {
    const driver = root.keys[d];
    // JSON has no comments, so a key beginning with "//" is treated as one —
    // the convention that lets a shipped pack document itself.
    if (driver.startsWith("//")) continue;
    const commands = root.vals[d];
    if (commands.kind !== "obj") {
      throw new ParserPackError(`${label}.${driver}: expected an object of command rules`);
    }
    const scope = table.scopeFor(driver);
    for (let c = 0; c < commands.keys.length; c += 1) {
      const command = commands.keys[c];
      if (command.startsWith("//")) continue;
      const spec = commands.vals[c];
      if (spec.kind !== "obj") {
        throw new ParserPackError(`${label}.${driver}."${command}": expected a rule object`);
      }
      scope.add(command, ruleParser(compileRule(spec, `${label}.${driver}."${command}"`)));
    }
  }
  return table;
}

/** Read and compile one declarative pack file. */
export function loadParserPack(specPath: string): ParserTable {
  const resolved = expandUser(specPath);
  if (!existsSync(resolved)) {
    throw new ParserPackError(`parser pack not found: ${resolved}`);
  }
  let root: Json;
  try {
    root = parseJson(readFileSync(resolved, "utf8"));
  } catch (err) {
    const detail = err instanceof Error ? err.message : "unreadable";
    throw new ParserPackError(`parser pack is not valid JSON (${resolved}): ${detail}`);
  }
  return compileParserPack(root, resolved);
}

/** Read and merge every `--parsers` source, later sources winning. */
export function loadParserPacks(specs: string[]): ParserTable {
  const table = new ParserTable();
  for (const spec of specs) {
    if (spec.trim() === "") continue;
    table.merge(loadParserPack(spec.trim()));
  }
  return table;
}

/**
 * A parser that shells out. The program receives
 * `{"host","command","driver","raw"}` on stdin and must print one JSON value on
 * stdout; anything else is reported as a parse error rather than failing the run.
 */
export function commandParser(
  program: string,
  args: string[],
  timeoutMs: number = PARSER_COMMAND_TIMEOUT_MS,
): ParserFn {
  return (raw: string, ctx: ParserContext): Json => {
    const payload = jobj();
    payload.setStr("host", ctx.host);
    payload.setStr("command", ctx.command);
    payload.setStr("driver", ctx.driver);
    payload.setStr("raw", raw);
    const result = runProcessSync(program, args, renderJson(payload) + "\n", process.env, timeoutMs);
    if (!result.ok()) {
      return jobj().setStr("parseError", `parser command failed: ${result.output.trim()}`);
    }
    try {
      return parseJson(result.stdout.trim());
    } catch (err) {
      const detail = err instanceof Error ? err.message : "invalid JSON";
      return jobj().setStr("parseError", `parser command produced invalid JSON: ${detail}`);
    }
  };
}

/** A table whose `*`/`*` rule runs `program` for every command. */
export function commandParserTable(program: string, args: string[]): ParserTable {
  const table = new ParserTable();
  table.scopeFor("*").add("*", commandParser(program, args));
  return table;
}
