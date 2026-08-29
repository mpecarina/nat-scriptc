/**
 * src/command-files.ts — parse commands and the conditional command syntax.
 *
 * Conditional form: `when <operator>:<value> :: <command>`, where the operator
 * is one of contains | not-contains | equals | not-equals. The condition is
 * evaluated against the cleaned output of the previous command for that host.
 */

import { readFileSync } from "node:fs";

import { CommandSpec, OP_CONTAINS, OP_EQUALS, OP_NOT_CONTAINS, OP_NOT_EQUALS } from "./models.ts";
import { splitLines } from "./text.ts";

class ConditionPrefix {
  prefix: string;
  operator: string;

  constructor(prefix: string, operator: string) {
    this.prefix = prefix;
    this.operator = operator;
  }
}

const CONDITION_PREFIXES: ConditionPrefix[] = [
  new ConditionPrefix("when contains:", OP_CONTAINS),
  new ConditionPrefix("when not-contains:", OP_NOT_CONTAINS),
  new ConditionPrefix("when equals:", OP_EQUALS),
  new ConditionPrefix("when not-equals:", OP_NOT_EQUALS),
];

/** Parse one command line, conditional prefix included. */
export function parseCommandSpec(rawText: string): CommandSpec {
  const line = rawText.trim();
  if (line === "") throw new Error("Command cannot be empty");

  const lowered = line.toLowerCase();
  for (const entry of CONDITION_PREFIXES) {
    if (!lowered.startsWith(entry.prefix)) continue;

    const remainder = line.slice(entry.prefix.length);
    const separator = remainder.indexOf("::");
    const conditionValue = (separator === -1 ? remainder : remainder.slice(0, separator)).trim();
    const command = (separator === -1 ? "" : remainder.slice(separator + 2)).trim();
    if (separator === -1 || conditionValue === "" || command === "") {
      throw new Error("Conditional commands must use `when <operator>:<value> :: <command>` syntax");
    }
    const spec = new CommandSpec(command, line);
    spec.conditionOperator = entry.operator;
    spec.conditionValue = conditionValue;
    return spec;
  }

  return new CommandSpec(line, line);
}

/** Parse a command file's text: one command per line, `#` comments dropped. */
export function readCommandText(text: string): CommandSpec[] {
  const commands: CommandSpec[] = [];
  for (const rawLine of splitLines(text)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    commands.push(parseCommandSpec(line));
  }
  return commands;
}

/** Read commands from a file on disk. */
export function readCommandFile(filePath: string): CommandSpec[] {
  return readCommandText(readFileSync(filePath, "utf8"));
}

/** Evaluate a spec's condition against the previous command's output. */
export function conditionMatches(spec: CommandSpec, previousOutput: string): boolean {
  const text = previousOutput;
  const value = spec.conditionValue;
  if (spec.conditionOperator === OP_CONTAINS) return text.includes(value);
  if (spec.conditionOperator === OP_NOT_CONTAINS) return !text.includes(value);
  if (spec.conditionOperator === OP_EQUALS) return text.trim() === value.trim();
  if (spec.conditionOperator === OP_NOT_EQUALS) return text.trim() !== value.trim();
  return true;
}

/** The message recorded when a conditional command is skipped. */
export function skipReason(spec: CommandSpec): string {
  return `skipped: condition not met (${spec.conditionOperator} '${spec.conditionValue}')`;
}
