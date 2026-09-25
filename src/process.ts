/**
 * Child-process helpers.
 *
 * The statically compiled runtime gives `spawn` piped stdout/stderr but no
 * piped stdin, and `execFileSync` the reverse (stdin via `input`, but it blocks
 * the loop). Everything nat runs concurrently — every ssh invocation — goes
 * through `runProcess`; the one-shot helpers that must feed stdin (keychain
 * CLIs and external parser filters) use `runProcessSync`.
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";

/** Child processes an owner must be able to terminate as one lifecycle. */
export class ChildProcessRegistry {
  private children: ChildProcess[];

  constructor() {
    this.children = [];
  }

  add(child: ChildProcess): void {
    if (!this.children.includes(child)) this.children.push(child);
  }

  remove(child: ChildProcess): void {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
  }

  count(): number {
    return this.children.length;
  }

  /** Best-effort termination; callers may exit immediately after this. */
  terminateAll(): void {
    for (const child of this.children.slice()) {
      try {
        child.kill("SIGTERM");
      } catch (err) {
        // The process may have exited between the snapshot and the signal.
      }
    }
    this.children = [];
  }
}

/** What a finished child produced. */
export class ProcessResult {
  /** Exit status, or -1 when the child died to a signal or never started. */
  code: number;
  /** stdout and stderr interleaved in arrival order, as the transcript. */
  output: string;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Non-empty when the child could not be spawned at all. */
  spawnError: string;

  constructor() {
    this.code = -1;
    this.output = "";
    this.stdout = "";
    this.stderr = "";
    this.timedOut = false;
    this.spawnError = "";
  }

  ok(): boolean {
    return this.code === 0 && this.spawnError === "";
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(), ms);
  });
}

/** A child environment: the current one, plus `extra`. */
export function childEnv(extra: Map<string, string>): { [k: string]: string | undefined } {
  const env: { [k: string]: string | undefined } = {};
  const current = process.env;
  for (const key of Object.keys(current)) env[key] = current[key];
  for (const key of extra.keys()) {
    const value = extra.get(key);
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/**
 * Run a child to completion with stdin closed and both output streams captured.
 * `timeoutMs` of 0 disables the deadline. Never rejects: a spawn failure, a
 * signal death and a timeout all come back on the result.
 */
export function runProcess(
  file: string,
  args: string[],
  env: { [k: string]: string | undefined },
  timeoutMs: number,
  registry: ChildProcessRegistry | null = null,
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const result = new ProcessResult();
    // spawn never throws for a missing binary — it reports that through the
    // child's "error" event, which the handler below turns into spawnError.
    const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"], env });
    if (registry !== null) registry.add(child);

    let settled = false;
    let exited = false;
    let stdoutEnded = child.stdout === null;
    let stderrEnded = child.stderr === null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      if (registry !== null) registry.remove(child);
      resolve(result);
    };
    const finishIfDrained = (): void => {
      if (exited && stdoutEnded && stderrEnded) finish();
    };

    const out = child.stdout;
    if (out !== null) {
      out.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        result.stdout += text;
        result.output += text;
      });
      out.on("end", () => {
        stdoutEnded = true;
        finishIfDrained();
      });
    }
    const err = child.stderr;
    if (err !== null) {
      err.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        result.stderr += text;
        result.output += text;
      });
      err.on("end", () => {
        stderrEnded = true;
        finishIfDrained();
      });
    }

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        result.timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
    }

    child.on("error", (spawnErr: Error) => {
      result.spawnError = spawnErr.message;
      finish();
    });
    child.on("exit", (code: number | null) => {
      result.code = code === null ? -1 : code;
      exited = true;
      finishIfDrained();
    });
  });
}

/**
 * Run a child to completion synchronously, optionally feeding it stdin. A
 * positive `timeoutMs` bounds extensions that are not under nat's control;
 * zero leaves short OS credential-store operations unbounded. Secrets ride
 * stdin rather than an argv the process table would show.
 */
export function runProcessSync(
  file: string,
  args: string[],
  input: string,
  env: { [k: string]: string | undefined },
  timeoutMs: number = 0,
): ProcessResult {
  const result = new ProcessResult();
  try {
    const stdout = execFileSync(file, args, {
      encoding: "utf8",
      input,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
      timeout: timeoutMs,
    });
    result.code = 0;
    result.stdout = stdout;
    result.output = stdout;
  } catch (err) {
    result.code = 1;
    result.stderr = err instanceof Error ? err.message : "command failed";
    result.output = result.stderr;
    if (result.stderr.includes("ENOENT")) result.spawnError = result.stderr;
  }
  return result;
}

/**
 * Run a short probe and return whatever it printed, on either stream. Tools
 * that report their version on stderr (`ssh -V` among them) are the reason both
 * are captured.
 */
export function probeCommand(file: string, args: string[]): string {
  const result = spawnSync(file, args, { encoding: "utf8" });
  const text = `${result.stdout}${result.stderr}`.trim();
  return result.error === undefined ? text : "";
}

/** True when `file` resolves to something runnable on this host. */
export function commandExists(file: string): boolean {
  try {
    execFileSync("/bin/sh", ["-c", 'command -v "$1" >/dev/null 2>&1', "sh", file], {
      encoding: "utf8",
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch (err) {
    return false;
  }
}
