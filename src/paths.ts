/**
 * Where nat persists run history and credentials: `$NAT_HOME` when set, else
 * `$XDG_CONFIG_HOME/nat`, else `~/.config/nat`.
 */

import { mkdirSync } from "node:fs";
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
  const natHome = envValue("NAT_HOME");
  const xdg = envValue("XDG_CONFIG_HOME");
  let root = join(homedir(), ".config", "nat");
  if (natHome !== "") root = expandUser(natHome);
  else if (xdg !== "") root = join(xdg, "nat");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return new RunPaths(join(root, "runs"), join(root, "credentials.json"));
}

/** The default ssh client config nat reads as its inventory. */
export function defaultSshConfigPath(): string {
  return join(homedir(), ".ssh", "config");
}
