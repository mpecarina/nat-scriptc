/**
 * Clean up raw command transcripts.
 *
 * An interactive shell transcript carries the echoed command and a trailing
 * prompt line; both are removed here. Cleanup happens once, in the runner,
 * because only it knows whether an interactive shell was used — stripping again
 * destroys real output (an error naming the command looks exactly like an echo).
 */

import { PROMPT_SUFFIXES, splitLines, trimBlankEdges } from "./text.ts";

function looksLikePromptLine(line: string): boolean {
  const stripped = line.trim();
  if (stripped === "") return false;
  if (/\s/.test(stripped)) return false;
  return PROMPT_SUFFIXES.includes(stripped.charAt(stripped.length - 1));
}

/** Remove the echoed command and any trailing prompt from a shell transcript. */
export function stripCommandEcho(command: string, output: string, prompt = ""): string {
  let lines = splitLines(output);
  while (lines.length > 0 && lines[0].trim() === "") lines = lines.slice(1);

  const commandText = command.trim();
  const commandLines: string[] = [];
  for (const line of splitLines(command)) {
    const text = line.trim();
    if (text !== "") commandLines.push(text);
  }

  if (commandLines.length > 1) {
    // runShellText sends a multiline IOS/NX-OS block one line at a time and
    // synchronizes on the prompt between lines. Remove each line's echo and
    // those intermediate prompts while preserving any actual response text.
    const kept: string[] = [];
    let expected = 0;
    const known = prompt.trim();
    for (const line of lines) {
      const stripped = line.trim();
      if (expected < commandLines.length) {
        const wanted = commandLines[expected];
        if (stripped === wanted || stripped.endsWith(wanted)) {
          expected += 1;
          continue;
        }
        if ((known !== "" && (stripped === known || stripped.endsWith(known))) || looksLikePromptLine(line)) {
          continue;
        }
      }
      kept.push(line);
    }
    lines = kept;
  } else {
    let nonEmptySeen = 0;
    let removeThrough = -1;
    for (let index = 0; index < lines.length; index += 1) {
      const stripped = lines[index].trim();
      if (stripped === "") continue;
      nonEmptySeen += 1;
      if (
        stripped === commandText ||
        stripped.endsWith(commandText) ||
        (commandText !== "" && stripped.includes(commandText))
      ) {
        removeThrough = index;
        break;
      }
      // The echo is at the top of the transcript; giving up after three lines
      // of content keeps a later line that merely mentions the command intact.
      if (nonEmptySeen >= 3) break;
    }
    if (removeThrough >= 0) lines = lines.slice(removeThrough + 1);
  }

  lines = trimBlankEdges(lines);
  if (lines.length > 0) {
    const last = lines[lines.length - 1].trim();
    const known = prompt.trim();
    if (known !== "" && (last === known || last.endsWith(known))) lines.pop();
    else if (looksLikePromptLine(lines[lines.length - 1])) lines.pop();
  }

  return trimBlankEdges(lines).join("\n");
}

/** Trim the trailing newlines an exec-channel transcript ends with. */
export function trimTrailingNewlines(output: string): string {
  return output.replace(/[\r\n]+$/, "");
}
