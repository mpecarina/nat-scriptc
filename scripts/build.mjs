#!/usr/bin/env node
/**
 * scripts/build.mjs — compile nat for the machine it runs on.
 *
 *   node scripts/build.mjs [-o dist/nat] [--dev]
 *
 * The result is a standalone executable: no Node and no JavaScript engine. Its
 * native dependencies are the platform libc, the `ssh` client nat drives, and
 * the small POSIX helpers listed in the README. It is pinned to the LLVM
 * backend, so a tier regression fails loudly instead of silently shipping the
 * C lane's output.
 *
 * The readable C intermediary is a separate command — `npm run emit:c`.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(ROOT, "cli", "nat.ts");
const SCRIPTC = join(ROOT, "node_modules", ".bin", "scriptc");

const argv = process.argv.slice(2);
let out = join(ROOT, "dist", "nat");
let optimization = "release";
for (let i = 0; i < argv.length; i += 1) {
  if ((argv[i] === "-o" || argv[i] === "--out") && i + 1 < argv.length) {
    out = resolve(argv[i + 1]);
    i += 1;
  } else if (argv[i] === "--dev") {
    optimization = "dev";
  } else {
    console.error(`nat build: unknown option ${argv[i]}`);
    process.exit(2);
  }
}

mkdirSync(dirname(out), { recursive: true });

// Coupling the C inspection lane to every build keeps build/c permanently fresh
// — at the cost of roughly doubling build time, because it compiles the program
// a second time through the C backend. Left here, disabled, because that is a
// posture worth flipping rather than rewriting: uncomment to have `npm run
// build` always refresh the snapshot. While it is off, `npm run emit:c`
// generates build/c on demand, the inspection test skips when the snapshot is
// missing or stale, and CI emits it explicitly.
//
// const inspectionArgs = [join(ROOT, "scripts", "emit.mjs"), "c"];
// if (optimization === "dev") inspectionArgs.push("--dev");
// const inspection = spawnSync(process.execPath, inspectionArgs, { stdio: "inherit", cwd: ROOT });
// if (inspection.error) {
//   console.error(`nat build: could not emit the C inspection build (${inspection.error.message})`);
//   process.exit(1);
// }
// if ((inspection.status ?? 1) !== 0) process.exit(inspection.status ?? 1);

const result = spawnSync(
  SCRIPTC,
  ["build", ENTRY, "-o", out, "--backend", "llvm", "--optimization", optimization, "--no-keep-c"],
  {
    stdio: "inherit",
    cwd: ROOT,
  },
);

if (result.error) {
  console.error(`nat build: could not run scriptc (${result.error.message}). Run \`npm install\` first.`);
  process.exit(1);
}
process.exit(result.status ?? 1);
