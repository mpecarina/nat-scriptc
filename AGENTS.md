# nat — AGENTS.md

**Role:** `nat` — the device-interaction engine, compiled natively. It runs
commands over SSH against network OSes and returns **structured, parsed** output
(`--json` / `--parse`). It is the collection primitive callers use to gather
facts.

**Demonstrable signal** (what "working" means here):

- `yarn test` is green (no infrastructure required).
- `yarn coverage` reports 100% static — no dynamic remainder, no engine in
  the binary.
- `nat ... --parse` returns the structured command envelope
  (`commands:[{command, output, parsed}]`) — the exact shape downstream
  consumers thread through.

**Validate:**

```bash
yarn install --frozen-lockfile  # Yarn 1 only; npm, pnpm and bun are refused
yarn test                       # infra-free
yarn typecheck                  # against scriptc's declarations
yarn build && yarn test         # dist/nat, then the Node-vs-native differential
yarn emit:c                     # full build/c C source/runtime/compile-recipe snapshot
yarn build:c                    # rebuild that C with cc/zig — no scriptc involved
node cli/nat.ts --help          # CLI surface; see examples/
```

## Where things live

- `cli/nat.ts` — the entry point and every subcommand's rendering.
- `src/transport.ts` — the OpenSSH process transport: control master, exec, and
  the FIFO-backed interactive session.
- `src/session.ts` — the interactive state machine (prompt detection, sonic-cli
  and Cisco CLI preparation, nested ssh).
- `src/runner.ts` — per-host orchestration and fan-out.
- `src/sshconfig.ts`, `src/inventory.ts` — the host inventory.
- `src/json.ts` — the `Json` value tree; parsed output has no static shape, so
  it is modelled explicitly.
- `src/parsers-*.ts`, `src/drivers.ts` — the parser sets and the lookup table.
- `src/parser-packs.ts` — `--parsers` (declarative) and `--parser-cmd`.
- `src/store.ts` — run history as append-only JSON lines.
- `scripts/emit.mjs` — inspection artifacts: generated C, exact linked runtime
  source snapshot, compiler recipe, LLVM IR and typed IR.
- `test/fixtures/fake-ssh` — the offline ssh stand-in every transport test uses.

## Gotchas

- **Keep the `--parse`/`--json` envelope shape stable**; downstream consumers
  depend on it as a contract. `test/fixtures/parsers/golden.json` is the
  expected output over 37 fixtures and the suite asserts byte equality against
  it — change a parser's shape only with that file, deliberately.
- **This compiles to a native binary**, so the language surface is narrower than
  Node's: no `any`, no destructuring, no `for…in`, no default exports, no
  callback-form `String.replace`, no `Number.parseInt`. `yarn typecheck`
  catches most of it; `yarn build` is the authority. https://scriptc.dev/limitations
- **Regex capture groups**: an unmatched optional group is `undefined` under Node
  and `""` compiled. Always read optional groups with `group()` /
  `hasGroup()` from `src/text.ts`, never `m[i] === undefined`.
- **`spawn` has no piped stdin** in the compiled runtime. Anything that must feed
  a child uses `execFileSync` (`runProcessSync`) or, for a live session, the FIFO
  in `src/transport.ts`.
- **Yarn 1 is the only package manager.** `yarn.lock` is the lockfile;
  `packageManager` and `devEngines` in `package.json` make npm and pnpm refuse
  outright; a `preinstall` guard fails bun and anything else. Write commands as `yarn <script>`
  with arguments passed straight through — no `npm run`, no `--`.
- **Do not add `@types/node`.** Its presence changes which overloads the compiler
  sees and breaks the build; the typecheck deliberately uses scriptc's own
  declarations.
- **No `NaN` literals.** The IR serializer refuses to write one, which breaks
  `yarn emit:ir`. Use `number | null` for "no value", as
  `parseEosIpInterfaceBrief` does for its optional MTU column.
- **The complete `build/c` project is target-specific.** `nat.c` itself is
  target-neutral, but the runtime source set and recipe pick platform APIs and
  libc shims behind feature macros. They cannot be retargeted after the fact;
  `yarn emit:c --target <triple>` creates that platform's own directory.
  A stale `build/c` is skipped by both its inspection checks and the optional C
  differential; it never makes an ordinary source test fail.
- Not a service — it is a library/CLI dependency of a transport layer, so it has
  no port.
