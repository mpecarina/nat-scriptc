# nat

Network Automation Toolkit — a CLI that runs commands across the SSH hosts in
your `~/.ssh/config` and returns **structured, parsed** output.

It is written in TypeScript and compiled with [scriptc][scriptc] to a native
executable. There is no Node, V8, QuickJS engine or JavaScript bytecode in the
binary:

```console
$ scriptc coverage cli/nat.ts

  statements analyzed   4463
  compile statically    4463  (100%)

  fully static — this program has no dynamic remainder.

$ ls -lh dist/nat
-rwxr-xr-x  1.1M  dist/nat
$ file dist/nat
dist/nat: Mach-O 64-bit executable arm64
```

- **SSH**: the system `ssh` client, driven as a subprocess
- **Storage**: append-only JSON lines under nat's config directory
- **Secrets**: `security` on macOS, libsecret on Linux, or a private fallback file
- **Distribution**: one executable per target, roughly 1–4 MB

[scriptc]: https://scriptc.dev

## Requirements

An OpenSSH client (`ssh`, 8.4 or newer) and standard POSIX userland (`/bin/sh`, `mkfifo` and
`stty`) — preinstalled on macOS and mainstream Linux. There is no language VM
or bundled JavaScript engine. Development additionally needs Node 24+, Yarn 1
(classic; `corepack enable` picks up the pinned version), and clang for the C
inspection lane (`yarn emit:c`). The sources run directly
under Node's type stripping, which is how the source-side tests run.

## Install

```sh
yarn install         # dev dependencies (scriptc, typescript)
make build           # -> dist/nat
./dist/nat --version
```

This workspace is intentionally marked `private`: publishing it as one package
would silently bundle only the build host's `dist/nat`. Distribute the named
`dist/nat-<target>` artifacts instead; the local `bin` entry remains handy for
`yarn link` after `make build`.

Yarn 1 is the only supported package manager. `package.json` pins it through
`packageManager` and `devEngines`, which npm and pnpm refuse up front, and a
`preinstall` guard fails any other client such as bun. Other lockfiles are
gitignored.

Cross-compile for other platforms with [zig](https://ziglang.org) installed:

```sh
make build-cross                          # every target
node scripts/build-cross.mjs linux-x64    # or just one
```

| Target | Output | Size |
| --- | --- | --- |
| `darwin-arm64` / `darwin-x64` | Mach-O, host toolchain, no extra tools | about 1.1 MB |
| `linux-x64` / `linux-arm64` | ELF, needs only `libc.so.6` and `libm.so.6`, glibc 2.36 floor | 2.3–2.4 MB |
| `linux-x64-musl` / `linux-arm64-musl` | ELF, statically linked — no interpreter, no libc on the host | 4.0–4.1 MB |

The glibc builds require nothing beyond libc and libm (for example Debian 12 or
Ubuntu 24.04 and newer); the musl builds have no dynamic interpreter at all,
which suits Alpine or another minimal image that also supplies OpenSSH and the
POSIX tools listed above. One build host emits its matching Darwin artifact plus
all four Linux cross artifacts; the other Darwin architecture needs a matching
host. Release validation should exercise host-native macOS and Linux; musl and
cross artifacts should still be tested against your own fleet before production
use.

## Inspect the complete C intermediary

nat compiles through two native lanes, from the same typed IR onto the same
pinned runtime:

1. scriptc's readable C backend → `build/c/nat.c` and `build/c/nat`
2. the pinned LLVM backend → the shipping `dist/nat`

`yarn build` produces the shipping one. `yarn emit:c` produces the C one
on demand; it compiles the program a second time, so it is not part of every
build.

The C lane is not a partial pretty-printer. It is compiled and exercised by the
same Node-vs-native differential suite as `dist/nat`. It also records all the
native support code needed to inspect what went into that executable:

```text
build/c/nat.c                         complete generated program translation unit
build/c/runtime/                      exact linked runtime/vendor C, headers + notices
build/c/linked-sources.txt            translation units in the C executable
build/c/Makefile                      rebuilds it from those sources alone
build/c/compiler-invocations.json     compiler probes and compile/link recipe
build/c/nat.ir.json                   typed IR consumed by the C backend
build/c/typescript-module-map.json    C module ids mapped back to TypeScript files
build/c/source-manifest.json          versions + TypeScript/native SHA-256 hashes
build/c/nat                           independently executable C-backend binary
```

Generate only this inspection tree with `yarn emit:c`; generate C, textual
LLVM IR and scriptc's typed IR with `yarn emit`. `build/` is gitignored and
can always be regenerated from the pinned lockfile.

The production executable is generated directly by the LLVM backend, not by
feeding `nat.c` into it. Both backends consume the same typed IR and share the
same pinned native runtime; retaining and testing the C lane gives a readable,
source-annotated equivalent rather than pretending an optimized executable
contains recoverable source text.

### Build the C yourself

The snapshot is a standalone C project; nothing below runs scriptc.

```sh
yarn build:c                   # host compiler
yarn build:c --cc "zig cc"     # zig's bundled clang instead
cd build/c && make             # or drive the snapshot's own Makefile
cd build/c && make CC="zig cc"
```

`build:c` prints the command before running it, so changing a flag or opening
the `.c` it names is one copy away:

```console
$ yarn build:c
# 27 translation units from nat.c
cd build/c
cc -std=c11 -pthread -O2 … -Iruntime/src nat.c runtime/src/scr_array.c … -o nat-rebuilt

built build/c/nat-rebuilt  1.1M
run it:     build/c/nat-rebuilt --version
check it:   NAT_BINARY=build/c/nat-rebuilt node --test test/native.test.ts
```

The last line runs your hand-built binary through the same byte-for-byte
differential as the shipping one.

The recipe is not hand-written. A tracing wrapper shadows `clang` and `zig` on
`PATH` during the build and records the real argv, so `compileFlags`,
`includeDirs` and the translation-unit list in `source-manifest.json` — and the
generated `Makefile` — come from what the compiler actually ran. The manifest
keeps the exact compiler path for provenance, while the Makefile spells the
portable driver name (`cc` or `zig cc`) so moving the snapshot does not require
the tool to be installed at the original host's absolute path.
Copied headers and directly included C files are Makefile prerequisites, so
editing them causes an ordinary incremental rebuild instead of requiring a
manual `make clean`.

### The complete C project is per-platform

The generated program translation unit, `nat.c`, is target-neutral (and is
normally byte-identical between these snapshots). The runtime source set and
compile recipe are not: they select platform APIs (`arc4random_buf`,
`posix_spawn_file_actions_addchdir_np`, …), libc shims, and target flags for the
chosen platform. A complete macOS snapshot therefore **will not** rebuild as a
Linux program however you point its Makefile. Generate that platform's own C
project instead — zig supplies the sysroots:

```console
$ yarn emit:c --target x86_64-linux-gnu.2.36
emitting readable C -> build/c-x86_64-linux-gnu.2.36/nat.c

$ yarn build:c --target x86_64-linux-gnu.2.36
# target: x86_64-linux-gnu.2.36
built build/c-x86_64-linux-gnu.2.36/nat-rebuilt  5.4M

$ file -b build/c-x86_64-linux-gnu.2.36/nat-rebuilt
ELF 64-bit LSB executable, x86-64 … for GNU/Linux
```

Each target gets its own directory and its own `Makefile`, already pointed at
zig. Compare `source-manifest.json`, `linked-sources.txt`, the Makefiles, and
the two `runtime/` trees to see what portability costs; `nat.c` shows the
platform-independent program lowering.

## Usage

```sh
# List host aliases from the ssh config
nat inventory list

# Show resolved connection details for a host
nat inventory show <host>

# Run commands across one or more hosts
nat run host1 host2 -c "show version" -c "show interface status"

# Commands can also be given inline after `--` (one per argument)
nat run host1 host2 -- "show version" "show interface status"

# Target hosts by glob (quote it) or every alias in the ssh config with --all
nat run 'leaf*' -- "show version"
nat run --all -c "show version"

# Run commands from a file, streaming events live (`--file -` reads stdin)
nat run host1 --file commands.txt --watch

# Enter SONiC sonic-cli first
nat run leaf1 --enter-sonic-cli -c "show ip route"

# Test a parser against saved/piped output (no SSH)
ssh leaf1 df -h | nat parse -c "df -h" --driver linux --json

# Replay or stream a past run's events / results
nat watch <run-id>
nat results <run-id>
nat runs --host host1

# Store / read / remove a secret in the OS keychain
nat cred set host1 --kind password
nat cred get host1
nat cred delete host1 --kind passphrase

# Report the environment nat will use
nat doctor
```

Use `--ssh-config <path>` to point at an alternate SSH config file. The default
`~/.ssh/config` is optional for literal hosts, just as it is for `ssh`; when it
is absent, OpenSSH still applies its system config, local login user, default
keys and agent.

### Command files & conditionals

A command file has one command per line (`#` comments allowed). Conditional
commands run only when the previous command's output matches:

```
show version
when contains:Active :: write memory
when not-equals:up :: shutdown
```

Operators: `contains`, `not-contains`, `equals`, `not-equals`.

### Structured output (`--parse`, `--driver`, `--json`)

`--parse` converts each command's cleaned output into a structured object.
Because the same command prints differently across platforms, parsers are scoped
by **driver** (the host's target OS). A host's driver is resolved from, in order:

1. `--driver <os>` (applies to every host in the run)
2. a `#nat-driver <os>` comment in the host's ssh-config block
3. the built-in `generic` driver

The built-ins ship structured parsers for the common Unix commands, so they work
out of the box under the `generic`/`linux`/`sonic`/`vyos` drivers:

- `ls -l*` / `ll*` → `{ entries: [{ type, perms, links, owner, group, size, date, name, target }], count }`
- `df*`, `ps*` → `{ columns, rows }` (generic whitespace table)
- `ip addr*`, `ip route*` → `{ interfaces | routes, count }`
- anything else → `{ fields, lines }` (key/value extraction)

plus vendor parser sets for `sonic`, `eos`, `ios`, `nxos` and `vyos` covering
`show version`, interface status, IP interfaces, routes, LLDP/CDP neighbours,
ARP/MAC tables and the SONiC EVPN/VXLAN commands.

```sh
# parse `ls -lh /` into structured entries with no custom code
nat run host1 --driver linux -c "ls -lh /" --parse --json
```

Command keys support `*` globs (e.g. `"ls -l*"` matches `ls -lh /`), matched
exact → glob → `*` wildcard.

### The driver keyword lives in a comment

OpenSSH **refuses to read a config file containing a keyword it does not know**,
so the driver is a `#nat-driver` comment, which ssh ignores:

```
Host leaf1
    HostName 10.0.0.1
    User admin
    #nat-driver sonic
```

### Custom parsers

A compiled binary has no JavaScript engine, so custom parsers come in two forms
it can execute.

**Declarative packs** — `--parsers <pack.json|directory>`, repeatable, later
sources win. A directory loads its direct `*.json` files in lexical filename
order, so names such as `10-base.json`, `50-team.json`, and `90-site.json` make
layering explicit. Other files and nested directories are ignored; a directory
with no JSON packs is an error. Later definitions replace the same
driver/command key; the existing exact → glob → `*` matching order is unchanged.

```json
{
  "linux": {
    "ip -br addr": {
      "kind": "linux.briefAddresses",
      "list": "interfaces",
      "count": true,
      "row": {
        "pattern": "^(\\S+)\\s+(\\S+)\\s*(.*)$",
        "fields": [
          { "name": "name" },
          { "name": "state" },
          { "name": "up", "group": 2, "type": "boolean" },
          { "name": "addresses", "group": 3, "split": "\\s+", "filter": "^[0-9A-Fa-f:.]+/\\d+$" }
        ]
      }
    }
  }
}
```

A rule is one of: `fields` (named regex captures), `row` + `list` (repeated
per-line matching), `table: true` / `keyValue: true` (reuse a built-in), or
`lines: true`. Field options: `pattern`, `group`, `flags`, `type`
(`string`|`number`|`boolean`) and `split` (turn one capture into an array). A
`filter` regex can retain only matching items in a split array. A key beginning
with `//` is a comment. See
[`examples/parsers.json`](examples/parsers.json) and the layered
[`examples/parsers.d/`](examples/parsers.d/) directory.

**External programs** — `--parser-cmd <program>`, for anything a regex cannot do:

```sh
nat run leaf1 -c "show interface counters" --parser-cmd ./examples/parser-cmd.py --json
```

The program receives `{"host","command","driver","raw"}` as JSON on stdin and
prints one JSON value on stdout, in any language. See
[`examples/parser-cmd.py`](examples/parser-cmd.py). Throwing is safe either way:
a failing pack rule or program is recorded as `{ parseError }` on that command,
and the run still succeeds. External parser programs are capped at 30 seconds,
so a stuck extension cannot stall the entire host run.

### `--json` envelope

`--json` emits the complete nested structure — run id, per-host results, and the
parsed object for every command — as clean JSON with no other output, so it can
be piped to `jq`. Parsed objects are also attached to events, so `watch` and
`watch --json` stream the same structure live.

```jsonc
{
  "runId": "…",
  "results": [
    {
      "hostAlias": "leaf1",
      "hostname": "…",
      "success": true,
      "platform": "sonic",
      "error": null,
      "commands": [
        { "command": "ip -br addr", "output": "…", "parsed": { /* your shape */ } }
      ]
    }
  ]
}
```

So `.results[].commands[] | select(.command == "<cmd>") | .parsed` always reaches
a parser's structured output. `nat results --json` emits the same envelope and
adds `createdAt` to results read back from history.

The built-in parser shapes are a contract:
[`test/fixtures/parsers/golden.json`](test/fixtures/parsers/golden.json) holds the
expected output for 37 fixtures, and the suite asserts byte equality against it.

### Example: structured parser + `jq` in a script

[`examples/interfaces-up.sh`](examples/interfaces-up.sh) reports the UP
interfaces on a host and their IPv4 addresses, using
[`examples/parsers.json`](examples/parsers.json) to give `ip -br addr` a shape
`jq` can walk:

```console
$ examples/interfaces-up.sh leaf1
host   interface  state  ipv4
leaf1  eth0       UP     192.168.1.10/24
leaf1  bond0      UP     10.0.0.5/30
```

### Test parsers offline (`nat parse`)

`nat parse` runs the parser chain against saved or piped output — no SSH needed —
so authoring a parser is a tight local loop:

```sh
ssh leaf1 df -h | nat parse -c "df -h" --driver linux --json | jq '.rows[]'
nat parse -c "ip -br addr" -i fixtures/ip-br.txt --parsers ./examples/parsers.json --json
nat parse -c "ip -br addr" -i fixtures/ip-br.txt --parsers ./examples/parsers.d --json
```

This is also the simplest way to add a regression test: capture a fixture once,
then assert on `nat parse … --json`.

### Jump hosts

`ProxyJump` from the ssh config is honoured automatically — OpenSSH resolves the
whole chain, including each hop's own config. Override it with `--jump <host>`.
Use `--jump-shell` to tunnel through the jump host's interactive shell (a nested
`ssh` typed into it) instead. Password-authenticated hops resolve their own
`nat cred` entry, so a bastion and final target may use different passwords.

### Secrets resolution

Passwords and key passphrases resolve from the environment first, then the OS
keychain:

- `NAT_SSH_PASSWORD` / `NAT_SSH_PASSWORD_<USER>`
- `NAT_SSH_PASSPHRASE` / `NAT_SSH_PASSPHRASE_<USER>`
- otherwise the keychain entry stored via `nat cred set`

`nat doctor` reports which store this host uses:

| Platform | Store |
| --- | --- |
| macOS | the login keychain, via `security` |
| Linux | libsecret (GNOME Keyring, KWallet, …), via `secret-tool` |
| neither | a `0600` file under nat's config directory, reported as such |

Set `NAT_CREDENTIAL_BACKEND=keychain|libsecret|file` to force one explicitly
(for example `file` on a headless Linux host with no unlocked desktop keyring).
Automatic file fallback is announced with a warning when a secret is stored.

A resolved secret reaches `ssh` through a generated askpass helper
(`SSH_ASKPASS` + `SSH_ASKPASS_REQUIRE=force`), so it never appears in an argv the
process table would show, and never touches disk. SSH keys (IdentityFile and the
usual `~/.ssh/id_*`) and a running `ssh-agent` are used automatically, by ssh
itself.

To authenticate without storing anything, prompt once and apply it to every host
in the run:

```sh
nat run 'leaf*' --ask-pass -c "show version"
```

The prompt is masked (no echo) and written to stderr, so it stays out of `--json`
output. When authentication fails, the error names which methods were tried and
how to add one, e.g. ``authentication failed (tried key, agent) — store a
password with `nat cred set leaf1` ``.

### SSH transport options

nat drives the system client, so its behaviour is OpenSSH's:

| Flag | Meaning |
| --- | --- |
| `--ssh-bin PATH` | the ssh executable (`$NAT_SSH_BIN`) |
| `--no-multiplex` | disable ControlMaster; exec commands use separate connections |
| `--host-key-checking M` | `yes` \| `no` \| `accept-new` (default) \| `ask` |
| `--ssh-option K=V` | an extra `-o` setting, repeatable |
| `-V`, `--verbose` | print each ssh invocation to stderr |

By default a host gets **one connection for the whole run**: a control master
authenticates once, and every command rides that socket. With
`--no-multiplex`, exec-channel commands open separate connections; drivers that
require an interactive CLI still keep one shell for the host's command sequence.

Host keys are checked: the default is `accept-new` (trust on first use, recorded
in `known_hosts`), and `--host-key-checking no` turns checking off.

Interactive sessions get a real pty from the remote side, but nat's own stdin is
a FIFO, so ssh requests the default 80×24. Before entering a device CLI nat
widens it (`stty rows 1000 cols 512` on the Unix-shell drivers, `terminal width
511` on the Cisco ones) so wide tables do not wrap and break the column parsers.

Each host's user, hostname, port, identity files and jump chain come from
`ssh -G`, so credential lookup and `inventory show` see exactly what the
connection will: `Match exec`, `Match localuser`, canonical/final passes,
platform options and OpenSSH's implicit local username. nat's own config reader
only lists aliases and reads `#nat-driver`.

## Data location

Runs are stored under `$NAT_HOME` when set, else `$XDG_CONFIG_HOME/nat`, else
`~/.config/nat`. Each run gets its own directory:

```
<root>/runs/<run-id>/run.json      the run header
<root>/runs/<run-id>/events.jsonl  one event per line, in order
<root>/runs/<run-id>/hosts.jsonl   one host result per line
```

Parallel `nat run` invocations write to different directories, so there is no
shared writer lock. `--no-store` skips the disk entirely.

## Other compiler intermediates

`yarn emit` writes all three: the [complete C
intermediary](#inspect-the-complete-c-intermediary), textual LLVM IR under
`build/llvm/`, and a standalone typed-IR lane under `build/ir/`. `emit:c`,
`emit:llvm` and `emit:ir` select one kind. Each lane has an executable beside
its source artifact.

Generated C symbols retain the TypeScript function name and module id, so they
are easy to grep. Use `build/c/typescript-module-map.json` to map that module id
back to the original file. When `build/c/nat` exists and its source manifest
still matches the TypeScript inputs, `yarn test` automatically runs the native
differential against both it and `dist/nat`; a stale snapshot is skipped.

## Development

```sh
yarn install
yarn test       # infra-free unit, integration and native differential tests
yarn typecheck  # against scriptc's own declarations — what passes, compiles
yarn coverage   # how much compiles statically, and why not
yarn build      # -> pinned-LLVM dist/nat
yarn emit       # -> build/{c,llvm,ir}/  every compiler representation
yarn build:c    # rebuild from build/c with an ordinary C compiler
```

Tests are infra-free. `test/fixtures/fake-ssh` is a POSIX-shell stand-in for the
ssh client that speaks the parts of the command line nat uses — the control
master, exec commands, and an interactive `-tt` session that echoes what it is
sent and answers with a prompt — so the whole transport, including the
password-through-askpass path, runs offline.

`test/native.test.ts` is a differential: it runs the same commands through the
sources under Node, the pinned-LLVM `dist/nat`, and (when current) the C-backend
`build/c/nat`, requiring byte-identical stdout, stderr and exit codes. It skips
when `dist/nat` has not been built; `NAT_BINARY` can select another primary
binary.

The project deliberately has no `@types/node`. scriptc typechecks in its own type
world (the `es2025` lib plus its own ambient declarations), so `yarn typecheck`
reads the same declarations the compiler does and tells you about an
unsupported API before the compiler does.

## License

MIT
