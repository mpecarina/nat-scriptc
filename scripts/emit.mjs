#!/usr/bin/env node
/**
 * scripts/emit.mjs — write the compiler's intermediate artifacts somewhere you
 * can read them.
 *
 *   node scripts/emit.mjs [c|llvm|ir|all]... [--out <dir>] [--target <triple>] [--dev]
 *
 * `dist/` holds shipped binaries; this writes to `build/` (gitignored), one
 * subdirectory per artifact kind, so generated code never fills `git status`:
 *
 *   build/c/nat.c          complete readable program C; build/c/runtime has
 *                          every linked native C unit/header and the module map
 *   build/llvm/nat.ll      textual LLVM IR, what the shipping backend hands to
 *                          the code generator
 *   build/ir/nat.ir.json   scriptc's own typed IR, before either backend
 *
 * Each kind also links an executable beside its source, because the published
 * CLI emits the artifact as a side effect of a build rather than instead of
 * one. The `c` one is worth keeping: running it is an independent check that
 * the two backends agree.
 *
 * The complete C project is TARGET-SPECIFIC. `nat.c` itself is target-neutral,
 * but the runtime source set and recipe select platform APIs
 * (`arc4random_buf`, `posix_spawn_file_actions_addchdir_np`, …) behind feature
 * macros. Retargeting a macOS snapshot at Linux therefore does not compile.
 * `--target <triple>` re-runs the whole compile through zig and writes a
 * separate directory, making the platform-dependent support code visible.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { arch, platform, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(ROOT, "cli", "nat.ts");
const SCRIPTC = join(ROOT, "node_modules", ".bin", "scriptc");
const RUNTIME_ROOT = join(ROOT, "node_modules", "@scriptc", "runtime");

/** kind → the extra scriptc flags that produce it. */
const KINDS = {
  c: { flags: ["--backend", "c", "--keep-c", "--emit-ir"], artifact: "nat.c", label: "readable C" },
  llvm: { flags: ["--backend", "llvm", "--keep-c"], artifact: "nat.ll", label: "textual LLVM IR" },
  ir: { flags: ["--emit-ir", "--no-keep-c"], artifact: "nat.ir.json", label: "typed scriptc IR" },
};

const argv = process.argv.slice(2);
const kinds = [];
let out = join(ROOT, "build");
let optimization = "release";
let target = "";

for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === "--out" && i + 1 < argv.length) {
    out = resolve(argv[i + 1]);
    i += 1;
  } else if (arg === "--target" && i + 1 < argv.length) {
    target = argv[i + 1];
    i += 1;
  } else if (arg === "--dev") {
    optimization = "dev";
  } else if (arg === "all") {
    for (const kind of Object.keys(KINDS)) {
      if (!kinds.includes(kind)) kinds.push(kind);
    }
  } else if (Object.prototype.hasOwnProperty.call(KINDS, arg)) {
    if (!kinds.includes(arg)) kinds.push(arg);
  } else {
    console.error(`nat emit: unknown argument '${arg}'. Kinds: ${Object.keys(KINDS).join(", ")}, all`);
    process.exit(2);
  }
}
if (kinds.length === 0) kinds.push("c");
if (target !== "" && (kinds.length !== 1 || kinds[0] !== "c")) {
  console.error("nat emit: --target applies to the 'c' kind only");
  process.exit(2);
}
/** `build/c` for the host, `build/c-<triple>` for a cross snapshot. */
const kindDir = (kind) => (kind === "c" && target !== "" ? `c-${target.replace(/[^A-Za-z0-9._-]/g, "-")}` : kind);

function humanSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}K`;
  return `${bytes}B`;
}

function lineCount(path) {
  try {
    let lines = 0;
    for (const ch of readFileSync(path, "utf8")) {
      if (ch === "\n") lines += 1;
    }
    return lines;
  } catch (err) {
    return 0;
  }
}

function executable(name) {
  const found = spawnSync("/bin/sh", ["-c", 'command -v "$1"', "sh", name], { encoding: "utf8" });
  return found.status === 0 ? found.stdout.trim() : "";
}

function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function hashFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function copyRuntimeFile(source, snapshotRoot) {
  const rel = relative(RUNTIME_ROOT, source);
  const target = join(snapshotRoot, rel);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  return rel;
}

/**
 * Keep provenance tied to the exact executable that scriptc invoked, while
 * making the copied C project usable on another machine whose tool lives at a
 * different absolute path. The generated sources require a C compiler (or
 * zig's C driver), not this host's particular installation path.
 */
function portableCompilerCommand(compilerArgv) {
  const parts = compilerArgv.trim().split(/\s+/);
  const tool = parts.length === 0 ? "" : basename(parts[0]);
  if (tool === "clang" || tool === "cc") return "cc";
  if (tool === "zig") return "zig cc";
  return compilerArgv;
}

/**
 * Preserve the native C behind the inspection executable, not only the emitted
 * program translation unit. The compiler wrapper records the real host-clang
 * invocations; from those we identify every linked scriptc runtime/vendor C
 * unit, recursively collect its local headers, and copy that exact source set
 * beside nat.c. `compiler-invocations.json` keeps the compile/link recipe too.
 */
function snapshotCBuild(dir, traceDir, realCompiler) {
  // Each trace record is the tool name followed by its argv. zig's driver is
  // invoked as `zig cc …`, so its leading "cc" is folded into the compiler
  // label and the argument list stays comparable with clang's.
  const invocations = [];
  for (const name of readdirSync(traceDir).sort()) {
    const fields = readFileSync(join(traceDir, name))
      .toString("utf8")
      .split("\0")
      .filter((field) => field !== "");
    if (fields.length < 2) continue;
    const tool = fields[0];
    let args = fields.slice(1);
    let compiler = realCompiler;
    if (tool === "zig") {
      compiler = `${realCompiler} cc`;
      if (args[0] === "cc") args = args.slice(1);
    }
    invocations.push({ compiler, args });
  }

  const includeRoots = [];
  const translationUnits = new Set();
  for (const invocation of invocations) {
    const args = invocation.args;
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === "-I" && i + 1 < args.length) {
        const root = resolve(args[i + 1]);
        if (root === RUNTIME_ROOT || isInside(RUNTIME_ROOT, root)) includeRoots.push(root);
        i += 1;
        continue;
      }
      const candidate = resolve(args[i]);
      if (candidate.endsWith(".c") && isInside(RUNTIME_ROOT, candidate) && existsSync(candidate)) {
        translationUnits.add(candidate);
      }
    }
  }

  const generated = join(dir, "nat.c");
  const supportFiles = new Set();
  const queue = [generated, ...translationUnits];
  while (queue.length > 0) {
    const source = queue.pop();
    let text = "";
    try {
      text = readFileSync(source, "utf8");
    } catch (err) {
      continue;
    }
    const includes = text.matchAll(/^\s*#\s*include\s*(["<])([^">]+)[">]/gm);
    for (const match of includes) {
      const candidates = [];
      if (match[1] === '"') candidates.push(join(dirname(source), match[2]));
      for (const root of includeRoots) candidates.push(join(root, match[2]));
      for (const rawCandidate of candidates) {
        const candidate = resolve(rawCandidate);
        if (!existsSync(candidate) || !isInside(RUNTIME_ROOT, candidate) || supportFiles.has(candidate)) continue;
        supportFiles.add(candidate);
        queue.push(candidate);
        break;
      }
    }
  }

  const snapshotRoot = join(dir, "runtime");
  rmSync(snapshotRoot, { recursive: true, force: true });
  mkdirSync(snapshotRoot, { recursive: true });

  // A standalone source snapshot must carry the notices for every vendor tree
  // represented in it. Some runtime units include vendor .c files directly
  // (Ryu is one example), so looking only at the linker's translation-unit
  // list would miss both that source and its license.
  const vendorRoots = new Set();
  for (const source of [...translationUnits, ...supportFiles]) {
    const rel = relative(RUNTIME_ROOT, source);
    const parts = rel.split(sep);
    if (parts.length >= 3 && parts[0] === "vendor") {
      vendorRoots.add(join(RUNTIME_ROOT, parts[0], parts[1]));
    }
  }
  const vendorNotices = new Set();
  for (const root of vendorRoots) {
    for (const name of readdirSync(root)) {
      if (!/^(license|copying)(?:[._-].*)?$/i.test(name)) continue;
      const notice = join(root, name);
      if (statSync(notice).isFile()) vendorNotices.add(notice);
    }
  }

  const copied = [];
  for (const source of [...translationUnits, ...supportFiles, ...vendorNotices].sort()) {
    copied.push(copyRuntimeFile(source, snapshotRoot));
  }
  const license = join(RUNTIME_ROOT, "LICENSE");
  if (existsSync(license)) copied.push(copyRuntimeFile(license, snapshotRoot));
  const projectLicense = join(ROOT, "LICENSE");
  if (existsSync(projectLicense)) copyFileSync(projectLicense, join(dir, "LICENSE"));

  const sanitize = (arg) => {
    if (!isAbsolute(arg)) return arg;
    if (arg === RUNTIME_ROOT) return "<scriptc-runtime>";
    if (isInside(RUNTIME_ROOT, arg)) return `<scriptc-runtime>/${relative(RUNTIME_ROOT, arg)}`;
    if (arg === ROOT) return "<repo>";
    if (isInside(ROOT, arg)) return `<repo>/${relative(ROOT, arg)}`;
    const tempRoot = tmpdir();
    if (arg === tempRoot) return "<tmp>";
    if (isInside(tempRoot, arg)) return `<tmp>/${relative(tempRoot, arg)}`;
    return arg;
  };
  writeFileSync(
    join(dir, "compiler-invocations.json"),
    JSON.stringify(
      invocations.map((invocation) => ({
        compiler: invocation.compiler,
        arguments: invocation.args.map(sanitize),
      })),
      null,
      2,
    ) + "\n",
  );

  const irPath = join(dir, "nat.ir.json");
  const moduleMap = {};
  const typescriptInputs = new Set();
  if (existsSync(irPath)) {
    const ir = JSON.parse(readFileSync(irPath, "utf8"));
    if (typeof ir.sourceFile === "string" && (ir.sourceFile === ROOT || isInside(ROOT, ir.sourceFile))) {
      typescriptInputs.add(ir.sourceFile);
    }
    for (const declaration of [...(ir.functions ?? []), ...(ir.classes ?? [])]) {
      const name = declaration.name ?? "";
      const match = /^%m(\d+)\./.exec(name) ?? /^%init\.(\d+)$/.exec(name);
      const file = declaration.loc?.file;
      if (match === null || typeof file !== "string") continue;
      const key = `m${match[1]}`;
      const display = isInside(ROOT, file) ? relative(ROOT, file) : file;
      if (isInside(ROOT, file)) typescriptInputs.add(file);
      if (moduleMap[key] === undefined) moduleMap[key] = display;
    }
    writeFileSync(join(dir, "typescript-module-map.json"), JSON.stringify(moduleMap, null, 2) + "\n");
  }

  // The flags the real link ran with, minus everything path-shaped: what is
  // left is the recipe a reader can re-run by hand, and the Makefile below
  // bakes in verbatim rather than inventing its own.
  // The link is the invocation that names the generated program; picking it by
  // content rather than by position keeps this correct however the trace
  // records happened to be ordered.
  let linkIndex = invocations.length - 1;
  for (let i = 0; i < invocations.length; i += 1) {
    if (invocations[i].args.some((arg) => resolve(arg) === generated)) linkIndex = i;
  }
  const finalInvocation = linkIndex >= 0 ? invocations[linkIndex].args : [];
  const compileFlags = [];
  for (let i = 0; i < finalInvocation.length; i += 1) {
    const arg = finalInvocation[i];
    if (arg === "-o" || arg === "-I" || arg === "-c") {
      i += 1;
      continue;
    }
    if (arg.startsWith("-I") || arg.startsWith("-o")) continue;
    if (arg.endsWith(".c") || arg.endsWith(".o")) continue;
    compileFlags.push(arg);
  }
  const includeDirs = [];
  for (const root of includeRoots) {
    const dirRelative = `runtime/${relative(RUNTIME_ROOT, root)}`;
    if (!includeDirs.includes(dirRelative)) includeDirs.push(dirRelative);
  }

  const scriptcPackage = JSON.parse(readFileSync(join(ROOT, "node_modules", "scriptc", "package.json"), "utf8"));
  const runtimePackage = JSON.parse(readFileSync(join(RUNTIME_ROOT, "package.json"), "utf8"));
  const compilerArgv = linkIndex >= 0 ? invocations[linkIndex].compiler : realCompiler;
  const compilerCommand = portableCompilerCommand(compilerArgv);
  const compilerProbe = spawnSync("/bin/sh", ["-c", '"$@" --version', "sh", ...compilerArgv.split(" ")], {
    encoding: "utf8",
  });
  const compilerVersion = String(compilerProbe.stdout ?? "").trim().split("\n")[0];
  const linkedSources = ["nat.c", ...[...translationUnits].sort().map((file) => `runtime/${relative(RUNTIME_ROOT, file)}`)];
  const compileDependencies = [...supportFiles].sort().map((file) => `runtime/${relative(RUNTIME_ROOT, file)}`);
  writeFileSync(join(dir, "linked-sources.txt"), linkedSources.join("\n") + "\n");
  writeFileSync(
    join(dir, "Makefile"),
    renderMakefile(compileFlags, includeDirs, linkedSources, compileDependencies, compilerCommand),
  );
  const sourceFiles = [
    ...(existsSync(join(dir, "LICENSE")) ? ["LICENSE"] : []),
    "nat.c",
    "Makefile",
    "compiler-invocations.json",
    "linked-sources.txt",
    ...(existsSync(irPath) ? ["nat.ir.json"] : []),
    ...(existsSync(join(dir, "typescript-module-map.json")) ? ["typescript-module-map.json"] : []),
    ...copied.map((file) => `runtime/${file}`),
  ].sort();
  const manifest = {
    program: "nat.c",
    executable: "nat",
    scriptcVersion: scriptcPackage.version,
    runtimeVersion: runtimePackage.version,
    host: `${platform()}-${arch()}`,
    compiler: { path: compilerArgv, command: compilerCommand, version: compilerVersion },
    target: target === "" ? null : target,
    compileFlags,
    includeDirs,
    typedIr: existsSync(irPath) ? "nat.ir.json" : null,
    typescriptModuleMap: existsSync(join(dir, "typescript-module-map.json")) ? "typescript-module-map.json" : null,
    translationUnits: linkedSources,
    compileDependencies,
    inputs: [...typescriptInputs].sort().map((file) => ({ file: relative(ROOT, file), sha256: hashFile(file) })),
    files: sourceFiles.map((file) => ({ file, sha256: hashFile(join(dir, file)) })),
  };
  writeFileSync(join(dir, "source-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  const emitCommand = target === "" ? "npm run emit:c" : `npm run emit:c -- --target ${target}`;
  const buildCommand = target === "" ? "npm run build:c" : `npm run build:c -- --target ${target}`;
  writeFileSync(
    join(dir, "README.md"),
    `# nat C inspection build\n\n` +
      `- \`nat.c\` is the complete readable C translation unit emitted from nat's TypeScript.\n` +
      `- \`runtime/\` contains every scriptc runtime/vendor C unit linked into \`nat\`, plus their transitive local headers.\n` +
      `- The project and every represented runtime/vendor license are included beside their sources.\n` +
      `- \`linked-sources.txt\` is the exact translation-unit list.\n` +
      `- \`Makefile\` rebuilds the program and tracks the copied headers: \`make\`, or \`make CC="zig cc"\`.\n` +
      `- \`compiler-invocations.json\` records the compiler probes and final compile/link recipe.\n` +
      `- \`nat.ir.json\` is the typed IR that fed the C backend.\n` +
      `- \`typescript-module-map.json\` maps C symbols such as \`%m3.*\` back to their TypeScript files.\n` +
      `- \`source-manifest.json\` pins compiler/runtime versions and SHA-256 hashes for TypeScript inputs and captured native sources.\n\n` +
      `Regenerate this directory with \`${emitCommand}\`; rebuild the program from it with\n` +
      `\`${buildCommand}\`, or \`make\` right here.\n`,
  );
}

/**
 * A standalone Makefile for the snapshot, so `cd build/c && make` rebuilds the
 * program with nothing but a C compiler. The flags and the file list are the
 * ones the trace actually recorded, not a hand-written approximation, and the
 * sources are spelled out so a reader can see exactly what gets compiled.
 */
function renderMakefile(compileFlags, includeDirs, linkedSources, compileDependencies, compilerCommand) {
  const sources = linkedSources.map((file) => `  ${file}`).join(" \\\n");
  const dependencies = compileDependencies.map((file) => `  ${file}`).join(" \\\n");
  const crossNote = target === ""
    ? `# These sources are for THIS host. The runtime's C picks platform APIs behind
# feature macros the compiler sets per target, so pointing this Makefile at
# another platform will not compile. Generate that platform's own C instead:
#
#   npm run emit:c -- --target x86_64-linux-gnu.2.36    # -> build/c-x86_64-linux-gnu.2.36
#   npm run emit:c -- --target aarch64-linux-musl
#
# Each writes its own directory with its own Makefile, already pointed at zig.`
    : `# These sources were generated for ${target}, and CFLAGS carries the matching
# -target flag, so \`make\` here cross-compiles through zig's bundled sysroots.
# The host's own C is in build/c.`;
  return `# Generated by nat's \`npm run emit:c\`. Do not edit — regenerate instead.
#
# This directory is a complete, standalone C project: the program translation
# unit scriptc emitted from nat's TypeScript, plus every runtime and vendor C
# unit that gets linked with it.
#
#   make                 build ./nat-rebuilt
#   make CC="zig cc"     build it with zig's bundled clang instead
#   make run             build it and print its version
#   make clean           remove the rebuilt binary
#
${crossNote}
#
# The flags below are the ones scriptc's own link used; see
# compiler-invocations.json for the untouched trace.

# A plain \`=\`, not \`?=\`: make PREDEFINES CC (to "cc"), so \`?=\` would never
# take effect and this would silently build with the wrong compiler. A command
# line still wins — \`make CC="zig cc"\` overrides any assignment in a Makefile.
CC = ${compilerCommand}
BIN ?= nat-rebuilt
CFLAGS ?= ${compileFlags.join(" ")}
CFLAGS_EXTRA ?=
INCLUDES = ${includeDirs.map((dir) => `-I${dir}`).join(" ")}

SOURCES = \\
${sources}

DEPENDENCIES = \\
${dependencies}

.PHONY: all run clean
all: $(BIN)

$(BIN): $(SOURCES) $(DEPENDENCIES)
\t$(CC) $(CFLAGS) $(CFLAGS_EXTRA) $(INCLUDES) $(SOURCES) -o $@

run: $(BIN)
\t./$(BIN) --version

clean:
\trm -f $(BIN)
`;
}

/**
 * Build the C lane through tracing compiler wrappers, returning its result.
 *
 * The wrappers shadow `clang` and `zig` on PATH, record the argv they were
 * given, then exec the real tool — which is how the snapshot learns the exact
 * translation units, include roots and flags rather than guessing them.
 * `SCRIPTC_NO_CACHE` keeps the vendor objects out of scriptc's build cache, so
 * a warm run traces the same set as a cold one.
 */
function buildCWithTrace(dir, flags) {
  const realClang = executable("clang");
  const realZig = executable("zig");
  const cross = target !== "";
  if (!cross && realClang === "") {
    console.error("nat emit: clang is required for the C inspection build");
    return { status: 1, error: null };
  }
  if (cross && realZig === "") {
    console.error(`nat emit: zig is required to emit C for ${target} (brew install zig)`);
    return { status: 1, error: null };
  }

  const temp = mkdtempSync(join(tmpdir(), "nat-c-inspect-"));
  const traceDir = join(temp, "trace");
  mkdirSync(traceDir);
  // The record is <tool>\0<argv…>. Names are zero-padded so the JSON reads in a
  // stable order; which record is the LINK is decided by content, not order.
  const shim = `#!/bin/sh
tool=\`basename "$0"\`
printf '%s\\0' "$tool" "$@" > "$(printf '%s/invocation.%012d' "$NAT_SCRIPTC_CC_TRACE" $$)"
case "$tool" in
  zig) exec "$NAT_SCRIPTC_REAL_ZIG" "$@" ;;
  *) exec "$NAT_SCRIPTC_REAL_CLANG" "$@" ;;
esac
`;
  for (const tool of ["clang", "zig"]) {
    writeFileSync(join(temp, tool), shim, { mode: 0o700 });
  }

  const env = {
    ...process.env,
    PATH: `${temp}:${process.env.PATH ?? ""}`,
    SCRIPTC_CC: cross ? "zigcc" : "clang",
    SCRIPTC_TARGET: cross ? target : "",
    SCRIPTC_NO_CACHE: "1",
    NAT_SCRIPTC_CC_TRACE: traceDir,
    NAT_SCRIPTC_REAL_CLANG: realClang,
    NAT_SCRIPTC_REAL_ZIG: realZig,
  };
  try {
    const result = spawnSync(
      SCRIPTC,
      ["build", ENTRY, "-o", join(dir, "nat"), "--optimization", optimization, ...flags],
      { stdio: ["ignore", "ignore", "inherit"], cwd: ROOT, env },
    );
    if ((result.status ?? 1) === 0) snapshotCBuild(dir, traceDir, cross ? realZig : realClang);
    return result;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

const produced = [];
let failures = 0;

for (const kind of kinds) {
  const spec = KINDS[kind];
  const dir = join(out, kindDir(kind));
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  console.log(`emitting ${spec.label} -> ${join(dir, spec.artifact)}`);
  const result = kind === "c"
    ? buildCWithTrace(dir, spec.flags)
    : spawnSync(
        SCRIPTC,
        ["build", ENTRY, "-o", join(dir, "nat"), "--optimization", optimization, ...spec.flags],
        { stdio: ["ignore", "ignore", "inherit"], cwd: ROOT },
      );
  if (result.error) {
    console.error(`nat emit: could not run scriptc (${result.error.message}). Run \`npm install\` first.`);
    process.exit(1);
  }
  if ((result.status ?? 1) !== 0) {
    failures += 1;
    continue;
  }

  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (!stat.isFile()) continue;
    const size = stat.size;
    const isSource = name !== "nat";
    produced.push({
      path: path.startsWith(ROOT) ? path.slice(ROOT.length + 1) : path,
      size,
      lines: isSource ? lineCount(path) : 0,
    });
  }
}

if (produced.length > 0) {
  console.log("");
  const width = Math.max(...produced.map((entry) => entry.path.length));
  for (const entry of produced) {
    const lines = entry.lines > 0 ? `${entry.lines} lines` : "executable";
    console.log(`  ${entry.path.padEnd(width)}  ${humanSize(entry.size).padStart(6)}  ${lines}`);
  }
}

if (failures > 0) {
  console.error(`\nnat emit: ${failures} kind(s) failed`);
  process.exit(1);
}
