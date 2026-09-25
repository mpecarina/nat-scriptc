/**
 * The command-line parser. Unlike `util.parseArgs`, each read returns the flag's
 * own type, and an unknown flag is reported by name.
 *
 * Accepted forms: `--name value`, `--name=value`, `-c value`, `-c=value`, and
 * clustered short booleans (`-qv`). A `--` separator is handled by the caller,
 * because `nat run` gives the tokens after it a meaning of their own.
 */

import { parseIntPrefix } from "./text.ts";

export class ArgError extends Error {}

export const KIND_STRING = "string";
export const KIND_BOOLEAN = "boolean";

/** One accepted flag. */
export class OptionSpec {
  long: string;
  /** Single-letter alias, or "". */
  short: string;
  kind: string;
  /** True when repeating the flag accumulates instead of replacing. */
  multiple: boolean;

  constructor(long: string, short: string, kind: string, multiple: boolean) {
    this.long = long;
    this.short = short;
    this.kind = kind;
    this.multiple = multiple;
  }
}

export function stringOption(long: string, short: string): OptionSpec {
  return new OptionSpec(long, short, KIND_STRING, false);
}

export function repeatedOption(long: string, short: string): OptionSpec {
  return new OptionSpec(long, short, KIND_STRING, true);
}

export function booleanOption(long: string, short: string): OptionSpec {
  return new OptionSpec(long, short, KIND_BOOLEAN, false);
}

/** The result of parsing: positionals plus every flag that appeared. */
export class ParsedArgs {
  positionals: string[];
  values: Map<string, string[]>;

  constructor() {
    this.positionals = [];
    this.values = new Map<string, string[]>();
  }

  has(name: string): boolean {
    return this.values.has(name);
  }

  bool(name: string): boolean {
    return this.values.has(name);
  }

  str(name: string, fallback: string): string {
    const values = this.values.get(name);
    if (values === undefined || values.length === 0) return fallback;
    return values[values.length - 1];
  }

  list(name: string): string[] {
    const values = this.values.get(name);
    return values === undefined ? [] : values;
  }

  /** An integer flag, or `fallback` when absent or unparsable. */
  int(name: string, fallback: number): number {
    const raw = this.str(name, "");
    if (raw === "") return fallback;
    return parseIntPrefix(raw, fallback);
  }
}

function findLong(specs: OptionSpec[], name: string): OptionSpec | null {
  for (const spec of specs) {
    if (spec.long === name) return spec;
  }
  return null;
}

function findShort(specs: OptionSpec[], name: string): OptionSpec | null {
  for (const spec of specs) {
    if (spec.short !== "" && spec.short === name) return spec;
  }
  return null;
}

function record(parsed: ParsedArgs, spec: OptionSpec, value: string): void {
  const existing = parsed.values.get(spec.long);
  if (existing === undefined) {
    parsed.values.set(spec.long, [value]);
    return;
  }
  if (spec.multiple) existing.push(value);
  else existing[existing.length - 1] = value;
}

/** Parse `args` against `specs`. Throws `ArgError` for anything unrecognized. */
export function parseArgs(args: string[], specs: OptionSpec[], allowPositionals: boolean): ParsedArgs {
  const parsed = new ParsedArgs();

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      if (body === "") {
        // A bare "--" this deep means the caller did not split on it; treat the
        // rest as positionals so nothing is silently dropped.
        for (let j = i + 1; j < args.length; j += 1) parsed.positionals.push(args[j]);
        break;
      }
      const eq = body.indexOf("=");
      const name = eq === -1 ? body : body.slice(0, eq);
      const spec = findLong(specs, name);
      if (spec === null) throw new ArgError(`unknown option: --${name}`);
      if (spec.kind === KIND_BOOLEAN) {
        if (eq !== -1) throw new ArgError(`option --${name} takes no value`);
        record(parsed, spec, "true");
        continue;
      }
      if (eq !== -1) {
        record(parsed, spec, body.slice(eq + 1));
        continue;
      }
      if (i + 1 >= args.length) throw new ArgError(`option --${name} requires a value`);
      i += 1;
      record(parsed, spec, args[i]);
      continue;
    }

    if (arg.length > 1 && arg.startsWith("-")) {
      const body = arg.slice(1);
      const eq = body.indexOf("=");
      if (eq !== -1) {
        const name = body.slice(0, eq);
        const spec = findShort(specs, name);
        if (spec === null) throw new ArgError(`unknown option: -${name}`);
        if (spec.kind === KIND_BOOLEAN) throw new ArgError(`option -${name} takes no value`);
        record(parsed, spec, body.slice(eq + 1));
        continue;
      }
      // A cluster of short flags; only the last may take a value.
      for (let c = 0; c < body.length; c += 1) {
        const letter = body.charAt(c);
        const spec = findShort(specs, letter);
        if (spec === null) throw new ArgError(`unknown option: -${letter}`);
        if (spec.kind === KIND_BOOLEAN) {
          record(parsed, spec, "true");
          continue;
        }
        const inline = body.slice(c + 1);
        if (inline !== "") {
          record(parsed, spec, inline);
          break;
        }
        if (i + 1 >= args.length) throw new ArgError(`option -${letter} requires a value`);
        i += 1;
        record(parsed, spec, args[i]);
        break;
      }
      continue;
    }

    if (!allowPositionals) throw new ArgError(`unexpected argument: ${arg}`);
    parsed.positionals.push(arg);
  }

  return parsed;
}

/** Split args at the first standalone `--`. */
export class SplitArgs {
  head: string[];
  tail: string[];

  constructor(head: string[], tail: string[]) {
    this.head = head;
    this.tail = tail;
  }
}

export function splitAtSeparator(args: string[]): SplitArgs {
  const index = args.indexOf("--");
  if (index === -1) return new SplitArgs(args, []);
  return new SplitArgs(args.slice(0, index), args.slice(index + 1));
}

export function wantsHelp(args: string[]): boolean {
  return args.includes("-h") || args.includes("--help");
}
