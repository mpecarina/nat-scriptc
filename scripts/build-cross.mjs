#!/usr/bin/env node
/**
 * scripts/build-cross.mjs — compile nat for every supported target.
 *
 *   node scripts/build-cross.mjs [target...]
 *
 * A matching Darwin target builds with the platform toolchain. Named Linux
 * artifacts always compile through zig's bundled clang and sysroots so their
 * libc target stays reproducible from either supported development host:
 *
 *   brew install zig     # or: https://ziglang.org/download
 *
 * The musl targets link statically, which is what an Alpine container or a
 * "copy one file onto the jump box" deployment wants.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { arch, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(ROOT, "cli", "nat.ts");
const SCRIPTC = join(ROOT, "node_modules", ".bin", "scriptc");
const DIST = join(ROOT, "dist");

/** name → the SCRIPTC_TARGET triple, or "" for the host toolchain. */
const TARGETS = {
  "darwin-arm64": { triple: "", host: platform() === "darwin" && arch() === "arm64" },
  "darwin-x64": { triple: "", host: platform() === "darwin" && arch() === "x64" },
  "linux-x64": { triple: "x86_64-linux-gnu.2.36", host: false },
  "linux-arm64": { triple: "aarch64-linux-gnu.2.36", host: false },
  "linux-x64-musl": { triple: "x86_64-linux-musl", host: false },
  "linux-arm64-musl": { triple: "aarch64-linux-musl", host: false },
};

const requested = process.argv.slice(2);
const explicitTargets = requested.length > 0;
const names = explicitTargets ? requested : Object.keys(TARGETS);
for (const name of names) {
  if (!Object.prototype.hasOwnProperty.call(TARGETS, name)) {
    console.error(`nat build-cross: unknown target '${name}'. Known: ${Object.keys(TARGETS).join(", ")}`);
    process.exit(2);
  }
}

mkdirSync(DIST, { recursive: true });

// The generated program C is target-neutral. Capture it once together with the
// host-native runtime source/recipe (the manifest records that host) before
// producing target binaries; platform branches remain visible in those units.
const inspection = spawnSync(process.execPath, [join(ROOT, "scripts", "emit.mjs"), "c"], {
  stdio: "inherit",
  cwd: ROOT,
});
if (inspection.error || (inspection.status ?? 1) !== 0) {
  console.error("nat build-cross: C inspection intermediary failed");
  process.exit(inspection.status ?? 1);
}

const hasZig = spawnSync("zig", ["version"], { stdio: "ignore" }).status === 0;
let failures = 0;

for (const name of names) {
  const target = TARGETS[name];
  const out = join(DIST, `nat-${name}`);
  const env = { ...process.env };

  if (!target.host) {
    if (target.triple === "") {
      const message = `${name} needs a matching ${name} host`;
      if (explicitTargets) {
        console.error(`cannot build ${name}: ${message}`);
        failures += 1;
      } else {
        console.log(`skipping ${name}: ${message}`);
      }
      continue;
    }
    if (!hasZig) {
      console.error(`skipping ${name}: zig is not installed (brew install zig)`);
      failures += 1;
      continue;
    }
    env.SCRIPTC_CC = "zigcc";
    env.SCRIPTC_TARGET = target.triple;
  }

  console.log(`building ${out}${target.triple === "" ? " (host toolchain)" : ` (${target.triple})`}`);
  const result = spawnSync(SCRIPTC, ["build", ENTRY, "-o", out, "--backend", "llvm", "--no-keep-c"], {
    stdio: "inherit",
    cwd: ROOT,
    env,
  });
  if ((result.status ?? 1) !== 0) failures += 1;
}

if (failures > 0) {
  console.error(`nat build-cross: ${failures} target(s) failed`);
  process.exit(1);
}
console.log("done");
