#!/usr/bin/env node
/**
 * scripts/build-c.mjs — rebuild nat from the emitted C, with your own compiler.
 *
 *   node scripts/build-c.mjs [--target <triple>] [--cc "<compiler>"]
 *                            [--dir <snapshot>] [-o <path>] [--run]
 *
 * `npm run emit:c` writes a self-contained C project (see build/c/README.md);
 * this compiles it. Nothing here needs scriptc — the snapshot is just C, and
 * that is the point: once the TypeScript has become C, an ordinary compiler
 * takes it the rest of the way.
 *
 *   npm run build:c                          # host C, host compiler
 *   npm run build:c -- --cc "zig cc"         # host C, zig's bundled clang
 *   npm run build:c -- --target x86_64-linux-gnu.2.36   # Linux C, via zig
 *
 * The command it runs is printed before it runs, so the next step — running it
 * yourself, changing a flag, opening the .c it names — is always one copy away.
 * `cd build/c && make` does the same thing through the generated Makefile.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
let dir = "";
let target = "";
let cc = "";
let out = "";
let run = false;

for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === "--dir" && i + 1 < argv.length) {
    dir = resolve(argv[i + 1]);
    i += 1;
  } else if (arg === "--target" && i + 1 < argv.length) {
    target = argv[i + 1];
    i += 1;
  } else if (arg === "--cc" && i + 1 < argv.length) {
    cc = argv[i + 1];
    i += 1;
  } else if ((arg === "-o" || arg === "--out") && i + 1 < argv.length) {
    out = resolve(argv[i + 1]);
    i += 1;
  } else if (arg === "--run") {
    run = true;
  } else {
    console.error(`nat build:c: unknown option ${arg}`);
    process.exit(2);
  }
}

if (dir === "") {
  const name = target === "" ? "c" : `c-${target.replace(/[^A-Za-z0-9._-]/g, "-")}`;
  dir = join(ROOT, "build", name);
}

const manifestPath = join(dir, "source-manifest.json");
if (!existsSync(manifestPath)) {
  const how = target === "" ? "npm run emit:c" : `npm run emit:c -- --target ${target}`;
  console.error(`nat build:c: no C snapshot in ${dir}. Generate it first:\n\n    ${how}\n`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (out === "") out = join(dir, "nat-rebuilt");

// The manifest retains the exact compiler path for provenance but also records
// a portable command (`cc` or `zig cc`) for rebuilding elsewhere. Older
// snapshots have only `path`, so keep that as the compatibility fallback.
const compilerSpec = cc !== "" ? cc : manifest.compiler.command ?? manifest.compiler.path;
const compiler = compilerSpec.trim().split(/\s+/);
const args = [
  ...manifest.compileFlags,
  ...manifest.includeDirs.map((include) => `-I${include}`),
  ...manifest.translationUnits,
  "-o",
  out,
];

console.log(`# ${manifest.translationUnits.length} translation units from ${manifest.program}`);
if (manifest.target !== null && manifest.target !== undefined) console.log(`# target: ${manifest.target}`);
console.log(`\ncd ${dir}\n${[...compiler, ...args].join(" ")}\n`);

const result = spawnSync(compiler[0], [...compiler.slice(1), ...args], { stdio: "inherit", cwd: dir });
if (result.error) {
  console.error(`nat build:c: could not run ${compiler[0]} (${result.error.message})`);
  process.exit(1);
}
if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);

const size = statSync(out).size;
console.log(`\nbuilt ${out.startsWith(ROOT) ? out.slice(ROOT.length + 1) : out}  ${(size / (1024 * 1024)).toFixed(1)}M`);

if (run) {
  const ran = spawnSync(out, ["--version"], { stdio: "inherit" });
  process.exit(ran.status ?? 1);
}

if (manifest.target === null || manifest.target === undefined) {
  const relative = out.startsWith(ROOT) ? out.slice(ROOT.length + 1) : out;
  console.log(`\nrun it:     ${relative} --version`);
  console.log(`check it:   NAT_BINARY=${relative} node --test test/native.test.ts`);
}
