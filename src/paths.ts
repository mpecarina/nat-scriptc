/**
 * src/paths.ts — resolve where nat persists run history and credentials.
 *
 * Order: $NAT_HOME, $XDG_CONFIG_HOME/nat, ~/.config/nat, then ~/.nat. The first
 * that already exists wins so an established install keeps its location; when
 * none exists the first candidate is created.
 */

import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { RunPaths } from "./models.ts";

/** `~` and `~/...` expand against the current user's home directory. */
export function expandUser(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function envValue(name: string): string {
  const value = process.env[name];
  return value === undefined ? "" : value;
}

/** The directory nat stores state in, creating it when absent. */
export function resolveRunPaths(): RunPaths {
  const home = homedir();

  // NAT_HOME is an explicit override, so it is honoured whether or not it
  // exists yet. Falling through to a shared default would be worse than
  // creating the directory: a test or a sandboxed run would silently write
  // into the user's real history.
  const natHome = envValue("NAT_HOME");
  if (natHome !== "") return makePaths(expandUser(natHome));

  const candidates: string[] = [];
  const xdg = envValue("XDG_CONFIG_HOME");
  if (xdg !== "") candidates.push(join(xdg, "nat"));
  candidates.push(join(home, ".config", "nat"));
  candidates.push(join(home, ".nat"));

  let root = candidates[0];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      root = candidate;
      break;
    }
  }
  return makePaths(root);
}

function makePaths(root: string): RunPaths {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return new RunPaths(root, join(root, "runs"), join(root, "credentials.json"));
}

/** The default ssh client config nat reads as its inventory. */
export function defaultSshConfigPath(): string {
  return join(homedir(), ".ssh", "config");
}
