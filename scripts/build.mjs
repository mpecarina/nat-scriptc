#!/usr/bin/env node
/**
 * Compile nat for the machine it runs on.
 *
 *   node scripts/build.mjs [-o dist/nat] [--dev]
 *
 * Pinned to the LLVM backend, so a tier regression fails loudly instead of
 * silently shipping the C lane's output. `yarn emit:c` builds the readable
 * C intermediary separately.
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

const result = spawnSync(
  SCRIPTC,
  ["build", ENTRY, "-o", out, "--backend", "llvm", "--optimization", optimization, "--no-keep-c"],
  {
    stdio: "inherit",
    cwd: ROOT,
  },
);

if (result.error) {
  console.error(`nat build: could not run scriptc (${result.error.message}). Run \`yarn install\` first.`);
  process.exit(1);
}
process.exit(result.status ?? 1);
