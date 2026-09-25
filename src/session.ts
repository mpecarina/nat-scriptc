/**
 * Drive an interactive CLI over a shell channel.
 *
 * Network operating systems answer differently over an exec channel than over a
 * terminal: SONiC's `sonic-cli` and Cisco's IOS/NX-OS config mode only exist in
 * an interactive session, and IOS-XE silently drops a multi-line `configure
 * terminal` block sent as an exec command. So those drivers get a real session,
 * and this module is the state machine that reads it: send a line, read until
 * the prompt comes back, decide what to send next.
 *
 * Prompt detection is deliberately forgiving. A device that switches prompts
 * mid-session — `sonic1#` → `sonic1(config)#` → `sonic1(config-if)#` — would
 * never match a fixed prompt again, so a settled buffer whose last line still
 * *looks* like a prompt also ends a read. Without that, every config-mode
 * command would block for its full timeout.
 */

import { ShellChannel, SshConnection } from "./transport.ts";
import { sleep } from "./process.ts";
import { PROMPT_SUFFIXES, lastNonEmptyLine, shellQuote, splitLines } from "./text.ts";

/** A freshly opened session: the channel and the prompt its banner ended with. */
export class ShellStart {
  channel: ShellChannel;
  /** The detected prompt, or "" when the banner produced none. */
  prompt: string;

  constructor(channel: ShellChannel, prompt: string) {
    this.channel = channel;
    this.prompt = prompt;
  }
}

export function looksLikePrompt(line: string): boolean {
  const stripped = line.trim();
  if (stripped === "") return false;
  return PROMPT_SUFFIXES.includes(stripped.charAt(stripped.length - 1));
}

/** True when the buffer's last content line is (or ends with) `prompt`. */
export function promptSeen(buffer: string, prompt: string): boolean {
  if (prompt === "") return false;
  const lines = splitLines(buffer);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const stripped = lines[index].trim();
    if (stripped === "") continue;
    return stripped === prompt || stripped.endsWith(prompt);
  }
  return false;
}

/**
 * Read the login banner until the channel settles. `idleRounds` is the ceiling —
 * a banner that has already produced a prompt-shaped last line ends the read
 * after two quiet polls, so a fast device is not made to wait for a slow one.
 */
async function drainShell(channel: ShellChannel, idleRounds: number, sleepMs: number): Promise<string> {
  let idle = 0;
  let collected = "";
  while (idle < idleRounds) {
    if (channel.hasData()) {
      collected += channel.take();
      idle = 0;
      continue;
    }
    idle += 1;
    if (idle >= 2 && collected !== "") {
      const last = lastNonEmptyLine(collected);
      if (last !== null && looksLikePrompt(last)) break;
    }
    if (channel.closed) break;
    await sleep(sleepMs);
  }
  return collected;
}

/**
 * Read until the prompt returns, the buffer settles on something prompt-shaped,
 * or the timeout expires. `prompt` may be "" to mean "no prompt is known yet",
 * in which case any settled buffer ends the read.
 */
export async function readUntilPrompt(
  channel: ShellChannel,
  prompt: string,
  timeoutSeconds: number,
  quietAfterPromptMs: number,
  fallbackQuietMs: number,
): Promise<string> {
  let collected = "";
  const started = Date.now();
  let lastData = started;
  let sawPromptAt = -1;

  while (true) {
    if (channel.hasData()) {
      collected += channel.take();
      lastData = Date.now();
      if (prompt !== "" && promptSeen(collected, prompt)) sawPromptAt = lastData;
      continue;
    }

    const tick = Date.now();
    if (prompt !== "" && sawPromptAt >= 0 && tick - sawPromptAt >= quietAfterPromptMs) break;
    // The quiet-buffer fallback. It fires when no prompt is known yet, or when
    // the device moved to a different prompt than the one supplied. Only a
    // settled buffer whose last line still looks like a prompt ends the read,
    // so mid-command output is never truncated.
    if (collected !== "" && tick - lastData >= fallbackQuietMs) {
      if (prompt === "") break;
      const last = lastNonEmptyLine(collected);
      if (last !== null && looksLikePrompt(last)) break;
    }
    if (channel.closed && !channel.hasData()) break;
    if (tick - started >= timeoutSeconds * 1000) break;
    await sleep(100);
  }
  return collected;
}

/** Open the interactive session and read its banner to learn the prompt. */
export async function openShell(connection: SshConnection, settleMs: number): Promise<ShellStart> {
  const channel = await connection.openShell();
  await sleep(settleMs);
  const banner = await drainShell(channel, 8, 200);
  // With a control master, authentication already happened in open(). Without
  // multiplexing the interactive child performs it here. An early ssh exit
  // must fail the host rather than look like a prompt-less, successful shell.
  if (channel.closed) throw connection.shellFailure(banner, channel);
  const prompt = lastNonEmptyLine(banner);
  return new ShellStart(channel, prompt === null ? "" : prompt);
}

/** Send one command and collect everything up to the next prompt. */
export async function runShellCommand(
  channel: ShellChannel,
  command: string,
  prompt: string,
  timeoutSeconds: number,
): Promise<string> {
  channel.sendLine(command, "\r\n");
  return readUntilPrompt(channel, prompt, timeoutSeconds, 500, 1500);
}

/**
 * Run one command *or* a multi-line block. A block — an IOS `configure terminal
 * … end` snippet passed as a single `-c`, say — is sent line by line with a
 * prompt sync between lines, which is how a human or an expect script pastes
 * config: no dropped characters, and sub-mode prompts stay in step.
 */
export async function runShellText(
  channel: ShellChannel,
  text: string,
  prompt: string,
  timeoutSeconds: number,
): Promise<string> {
  const lines = text.split(/\r?\n/);
  if (lines.length <= 1) return runShellCommand(channel, text, prompt, timeoutSeconds);
  let collected = "";
  for (const line of lines) {
    if (line.trim() === "") continue;
    collected += await runShellCommand(channel, line, prompt, timeoutSeconds);
  }
  return collected;
}

/**
 * Widen the pty before entering a device CLI. nat's session stdin is a FIFO, not
 * a terminal, so ssh asks the remote for the default 80×24 — narrow enough to
 * wrap `show interface status` and break every column-oriented parser. The
 * devices that start in a Unix shell (SONiC, plain Linux) can be told directly.
 */
export async function widenUnixPty(channel: ShellChannel, prompt: string, timeoutSeconds: number): Promise<void> {
  await runShellCommand(channel, "stty rows 1000 cols 512 2>/dev/null || true", prompt, timeoutSeconds);
}

/** Enter SONiC's `sonic-cli`, returning the transcript and the new prompt. */
export async function enterSonicCli(
  channel: ShellChannel,
  prompt: string,
  timeoutSeconds: number,
): Promise<ShellStart> {
  channel.sendLine("sonic-cli", "\r\n");
  const output = await readUntilPrompt(channel, "", timeoutSeconds, 500, 1500);
  const next = lastNonEmptyLine(output);
  const resolved = next !== null && next !== prompt ? next : prompt;
  return new ShellStart(channel, resolved);
}

/** Disable paging inside sonic-cli so long `show` output does not stop. */
export async function prepareSonicCli(
  channel: ShellChannel,
  prompt: string,
  timeoutSeconds: number,
): Promise<void> {
  await runShellCommand(channel, "terminal length 0", prompt, timeoutSeconds);
}

/**
 * Prepare an interactive Cisco IOS / IOS-XE / NX-OS CLI.
 *
 * Two steps: enter privileged EXEC when the banner prompt is user-EXEC (`>`),
 * answering an enable-password prompt with the host password if asked; then
 * disable paging and widen the terminal so long `show` output neither stops on
 * `--More--` nor wraps. Returns the resolved privileged prompt.
 */
export async function prepareIosCli(
  channel: ShellChannel,
  prompt: string,
  password: string,
  timeoutSeconds: number,
): Promise<string> {
  let current = prompt;
  if (current !== "" && current.trim().endsWith(">")) {
    channel.sendLine("enable", "\r\n");
    let out = await readUntilPrompt(channel, "", timeoutSeconds, 500, 1200);
    if (/password:/i.test(out) && password !== "") {
      channel.sendLine(password, "\r\n");
      out = await readUntilPrompt(channel, "", timeoutSeconds, 500, 1200);
    }
    const next = lastNonEmptyLine(out);
    if (next !== null) current = next;
  }
  await runShellCommand(channel, "terminal length 0", current, timeoutSeconds);
  const out = await runShellCommand(channel, "terminal width 511", current, timeoutSeconds);
  const resolved = lastNonEmptyLine(out);
  return resolved === null ? current : resolved;
}

/** The `ssh` line typed into a jump host's shell for `--jump-shell`. */
function buildNestedSshCommand(user: string, hostname: string, port: number): string {
  const parts: string[] = [
    "ssh",
    "-tt",
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "UserKnownHostsFile=/dev/null",
    "-o",
    "GlobalKnownHostsFile=/dev/null",
  ];
  if (port > 0 && port !== 22) {
    parts.push("-p");
    parts.push(`${port}`);
  }
  const destination = user === "" ? hostname : `${user}@${hostname}`;
  // This command is typed into the jump host's shell, unlike normal ssh argv.
  // Quote the only dynamic token so a config value cannot become shell syntax.
  parts.push(shellQuote(destination));
  return parts.join(" ");
}

/** The outcome of typing `ssh <target>` into a jump host's shell. */
class NestedResult {
  transcript: string;
  ready: boolean;

  constructor(transcript: string, ready: boolean) {
    this.transcript = transcript;
    this.ready = ready;
  }
}

async function readNestedSshUntilReady(
  channel: ShellChannel,
  basePrompt: string,
  password: string,
  timeoutSeconds: number,
): Promise<NestedResult> {
  let collected = "";
  const started = Date.now();
  let lastData = started;
  let sentPassword = false;
  let sentConfirmation = false;

  while (true) {
    if (channel.hasData()) {
      collected += channel.take();
      lastData = Date.now();

      const lowered = collected.toLowerCase();
      if (!sentConfirmation && /are you sure you want to continue connecting/.test(lowered)) {
        channel.sendLine("yes", "\r\n");
        sentConfirmation = true;
        await sleep(300);
        continue;
      }
      if (!sentPassword && /(password:|passphrase)/.test(lowered)) {
        if (password === "") return new NestedResult(collected, false);
        channel.sendLine(password, "\r\n");
        sentPassword = true;
        await sleep(500);
        continue;
      }
      if (/(permission denied|connection refused|could not resolve|no route to host|connection timed out)/.test(lowered)) {
        return new NestedResult(collected, false);
      }
      const last = lastNonEmptyLine(collected);
      if (last !== null && looksLikePrompt(last) && last !== basePrompt) {
        return new NestedResult(collected, true);
      }
      continue;
    }

    const tick = Date.now();
    if (collected !== "" && tick - lastData >= 1500) {
      const last = lastNonEmptyLine(collected);
      // The target and jump host may render the same prompt. Once the
      // transcript settles, a prompt-shaped line is enough; known SSH failures
      // were rejected above as soon as they arrived.
      if (last !== null && looksLikePrompt(last)) {
        return new NestedResult(collected, true);
      }
    }
    if (channel.closed && !channel.hasData()) return new NestedResult(collected, false);
    if (tick - started >= timeoutSeconds * 1000) return new NestedResult(collected, false);
    await sleep(150);
  }
}

/**
 * Tunnel through the jump host's interactive shell: type `ssh <target>` into it
 * and drive the nested login. Returns the target's prompt.
 */
export async function startNestedSsh(
  channel: ShellChannel,
  basePrompt: string,
  user: string,
  hostname: string,
  port: number,
  password: string,
  timeoutSeconds: number,
): Promise<string> {
  channel.sendLine(buildNestedSshCommand(user, hostname, port), "\r\n");
  const outcome = await readNestedSshUntilReady(channel, basePrompt, password, timeoutSeconds);
  if (!outcome.ready) {
    throw new Error(`Failed to open nested SSH session to ${hostname}:\n${outcome.transcript.trim()}`);
  }
  const prompt = lastNonEmptyLine(outcome.transcript);
  return prompt === null ? basePrompt : prompt;
}
