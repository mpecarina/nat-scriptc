/**
 * src/credentials.ts — SSH passwords and key passphrases in the OS keychain.
 *
 * `Bun.secrets` is not available to a natively compiled binary, so nat talks to
 * the same stores through the tools the platforms ship:
 *
 *   macOS   `security` (login keychain)
 *   Linux   `secret-tool` (libsecret — GNOME Keyring, KWallet, …)
 *   neither a 0600 file under nat's config directory, with a warning
 *
 * Secrets are always handed over on stdin, never in an argv, so they never
 * appear in the process table.
 */

import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { platform } from "node:os";

import { Json, jobj, parseJson, renderJsonPretty } from "./json.ts";
import { commandExists, runProcessSync } from "./process.ts";
import { resolveRunPaths } from "./paths.ts";

export class CredentialError extends Error {}

const SERVICE_PREFIX = "nat";

export const BACKEND_KEYCHAIN = "keychain";
export const BACKEND_LIBSECRET = "libsecret";
export const BACKEND_FILE = "file";

/** "" and "password" both mean the login password. */
export function normalizeKind(kind: string): string {
  const value = kind.trim().toLowerCase();
  if (value === "" || value === "password") return "password";
  if (value === "passphrase") return "passphrase";
  return value;
}

function serviceName(host: string, kind: string): string {
  return `${SERVICE_PREFIX}:${host}:${normalizeKind(kind)}`;
}

let cachedBackend = "";

/** Which secret store this host uses. `NAT_CREDENTIAL_BACKEND` overrides it. */
export function credentialBackend(): string {
  if (cachedBackend !== "") return cachedBackend;
  const forced = process.env["NAT_CREDENTIAL_BACKEND"];
  if (forced !== undefined && forced !== "") {
    const selected = forced.trim().toLowerCase();
    if (selected !== BACKEND_KEYCHAIN && selected !== BACKEND_LIBSECRET && selected !== BACKEND_FILE) {
      throw new CredentialError(
        `invalid NAT_CREDENTIAL_BACKEND '${forced}' (expected keychain, libsecret, or file)`,
      );
    }
    cachedBackend = selected;
    return cachedBackend;
  }
  if (platform() === "darwin" && commandExists("security")) cachedBackend = BACKEND_KEYCHAIN;
  else if (commandExists("secret-tool")) cachedBackend = BACKEND_LIBSECRET;
  else cachedBackend = BACKEND_FILE;
  return cachedBackend;
}

/** A human-readable note about where secrets land, for `nat cred` output. */
export function backendDescription(): string {
  const backend = credentialBackend();
  if (backend === BACKEND_KEYCHAIN) return "macOS keychain";
  if (backend === BACKEND_LIBSECRET) return "libsecret";
  return `file (${resolveRunPaths().credentialsPath}, mode 0600)`;
}

/* --------------------------------- file ---------------------------------- */

function readFileStore(): Json {
  const path = resolveRunPaths().credentialsPath;
  if (!existsSync(path)) return jobj();
  try {
    const parsed = parseJson(readFileSync(path, "utf8"));
    return parsed.kind === "obj" ? parsed : jobj();
  } catch (err) {
    return jobj();
  }
}

function writeFileStore(store: Json): void {
  const path = resolveRunPaths().credentialsPath;
  const pending = `${path}.${process.pid}.tmp`;
  writeFileSync(pending, renderJsonPretty(store, 2) + "\n", { mode: 0o600 });
  chmodSync(pending, 0o600);
  renameSync(pending, path);
}

/* ------------------------------- operations ------------------------------- */

/** Store a secret. Throws `CredentialError` when it is empty or the store fails. */
export function setSecret(host: string, user: string, secret: string, kind: string): void {
  if (secret.trim() === "") throw new CredentialError("empty secret refused");
  const service = serviceName(host, kind);
  const backend = credentialBackend();

  if (backend === BACKEND_KEYCHAIN) {
    // `-w` with no value reads the secret from stdin, twice (it asks for a
    // confirmation) — which keeps it out of the argv the process table shows.
    const result = runProcessSync(
      "security",
      ["add-generic-password", "-U", "-a", user, "-s", service, "-w"],
      `${secret}\n${secret}\n`,
      process.env,
    );
    if (!result.ok()) throw new CredentialError(`keychain write failed: ${result.output.trim()}`);
    return;
  }

  if (backend === BACKEND_LIBSECRET) {
    const result = runProcessSync(
      "secret-tool",
      ["store", "--label", service, "service", service, "account", user],
      secret,
      process.env,
    );
    if (!result.ok()) throw new CredentialError(`libsecret write failed: ${result.output.trim()}`);
    return;
  }

  const store = readFileStore();
  let bucket = store.get(service);
  if (bucket === null || bucket.kind !== "obj") {
    bucket = jobj();
    store.set(service, bucket);
  }
  bucket.setStr(user, secret);
  writeFileStore(store);
}

/** Read a stored secret, or "" when there is none. */
export function getSecret(host: string, user: string, kind: string): string {
  const service = serviceName(host, kind);
  const backend = credentialBackend();

  if (backend === BACKEND_KEYCHAIN) {
    const result = runProcessSync(
      "security",
      ["find-generic-password", "-a", user, "-s", service, "-w"],
      "",
      process.env,
    );
    if (!result.ok()) return "";
    return result.stdout.replace(/\r?\n$/, "");
  }

  if (backend === BACKEND_LIBSECRET) {
    const result = runProcessSync("secret-tool", ["lookup", "service", service, "account", user], "", process.env);
    if (!result.ok()) return "";
    return result.stdout.replace(/\r?\n$/, "");
  }

  const bucket = readFileStore().get(service);
  if (bucket === null || bucket.kind !== "obj") return "";
  return bucket.str(user, "");
}

/** Remove a stored secret. Returns false when there was nothing to remove. */
export function deleteSecret(host: string, user: string, kind: string): boolean {
  const service = serviceName(host, kind);
  const backend = credentialBackend();

  if (backend === BACKEND_KEYCHAIN) {
    return runProcessSync("security", ["delete-generic-password", "-a", user, "-s", service], "", process.env).ok();
  }
  if (backend === BACKEND_LIBSECRET) {
    if (getSecret(host, user, kind) === "") return false;
    return runProcessSync("secret-tool", ["clear", "service", service, "account", user], "", process.env).ok();
  }

  const store = readFileStore();
  const bucket = store.get(service);
  if (bucket === null || bucket.kind !== "obj" || !bucket.has(user)) return false;
  // Json has no member removal; rebuilding the bucket without the key is both
  // simple and keeps the file's insertion order stable for everything else.
  const replacement = jobj();
  for (let i = 0; i < bucket.keys.length; i += 1) {
    if (bucket.keys[i] === user) continue;
    replacement.set(bucket.keys[i], bucket.vals[i]);
  }
  store.set(service, replacement);
  writeFileStore(store);
  return true;
}

/* ---------------------------- environment first --------------------------- */

function normalizeForEnv(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, "_").toUpperCase();
}

function resolveFromEnv(prefix: string, username: string): string {
  const names: string[] = [];
  if (username !== "") names.push(`${prefix}_${normalizeForEnv(username)}`);
  names.push(prefix);
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value !== "") return value;
  }
  return "";
}

/**
 * The password for a host: an explicit override, then the environment, then the
 * keychain. "" when nothing is configured.
 */
export function resolvePassword(alias: string, user: string, override: string): string {
  if (override !== "") return override;
  const fromEnv = resolveFromEnv("NAT_SSH_PASSWORD", user);
  if (fromEnv !== "") return fromEnv;
  return getSecret(alias, user, "password");
}

/** The key passphrase for a host, resolved the same way. */
export function resolvePassphrase(alias: string, user: string, override: string): string {
  if (override !== "") return override;
  const fromEnv = resolveFromEnv("NAT_SSH_PASSPHRASE", user);
  if (fromEnv !== "") return fromEnv;
  return getSecret(alias, user, "passphrase");
}
