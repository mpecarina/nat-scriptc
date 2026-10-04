import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const ENTRY = join(ROOT, "cli", "nat.ts");
const BINARY = process.env["NAT_BINARY"] ?? join(ROOT, "dist", "nat");
const C_BINARY = join(ROOT, "build", "c", "nat");
const FAKE_SSH = join(HERE, "fixtures", "fake-ssh");

/**
 * Every available compiled lane and the same sources under Node must agree byte
 * for byte. `yarn build` produces the shipping LLVM binary and `yarn emit:c`
 * produces the optional C inspection executable; without dist/nat
 * these checks skip so a fresh clone's source-only test remains useful.
 */
const available = existsSync(BINARY);

/** build/c/nat joins the differential only while its manifest matches the current sources. */
function cBinaryIsFresh(): boolean {
  if (!existsSync(C_BINARY)) return false;
  const manifestPath = join(ROOT, "build", "c", "source-manifest.json");
  if (!existsSync(manifestPath)) return false;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      inputs?: { file?: string; sha256?: string }[];
    };
    if (!Array.isArray(manifest.inputs) || manifest.inputs.length === 0) return false;
    for (const entry of manifest.inputs) {
      if (typeof entry.file !== "string" || typeof entry.sha256 !== "string") return false;
      const path = join(ROOT, entry.file);
      if (!existsSync(path)) return false;
      const actual = createHash("sha256").update(readFileSync(path)).digest("hex");
      if (actual !== entry.sha256) return false;
    }
    return true;
  } catch (err) {
    return false;
  }
}

const binaries = cBinaryIsFresh() && C_BINARY !== BINARY ? [BINARY, C_BINARY] : [BINARY];

/** Mask the two values that legitimately differ between runs. */
function normalize(text: string): string {
  return text
    // scriptc's ucontext fibers trigger this known macOS ASan advisory before
    // main; preserve every actual ASan ERROR while ignoring the tool warning.
    .replace(
      /==\d+==WARNING: ASan is ignoring requested __asan_handle_no_return[^\n]*\nFalse positive error reports may follow\nFor details see https:\/\/github\.com\/google\/sanitizers\/issues\/189\n/g,
      "",
    )
    .replace(/\b[0-9a-f]{32}\b/g, "<run-id>")
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g, "<time>")
    .replace(/\/[^\s"]*nat-[A-Za-z0-9]{6,}/g, "<tmp>");
}

class Lab {
  home: string;
  replies: string;
  config: string;

  constructor() {
    const base = mkdtempSync(join(tmpdir(), "nat-diff-"));
    this.home = join(base, "home");
    this.replies = join(base, "replies");
    this.config = join(base, "ssh_config");
    mkdirSync(this.home, { recursive: true });
    mkdirSync(this.replies, { recursive: true });
    writeFileSync(
      this.config,
      [
        "Host leaf1",
        "    HostName 10.0.0.1",
        "    User admin",
        "    #nat-driver sonic",
        "",
        "Host web1",
        "    HostName 10.0.1.1",
        "    #nat-driver linux",
      ].join("\n") + "\n",
    );
    writeFileSync(join(this.replies, "cmd_show_version"), "SONiC Software Version: 4.1.0\nPlatform: x86-64\n");
    writeFileSync(join(this.replies, "cmd_uptime"), "up 3 days\n");
    writeFileSync(join(this.replies, "cmd_large"), "x".repeat(256 * 1024) + "\ntail\n");
    writeFileSync(join(this.replies, "cmd_ip_addr"), "2: eth0: <BROADCAST,UP,LOWER_UP> mtu 1500\n    inet 10.0.1.1/24 scope global eth0\n");
  }

  env(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const key of Object.keys(process.env)) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    // NODE_TEST_CONTEXT is private runner state. A plain Node child that
    // inherits it routes stdout through the test harness and truncates a large
    // standalone CLI write at 64 KiB, while a native process correctly ignores
    // it. The differential launches ordinary programs, not nested test workers.
    delete env["NODE_TEST_CONTEXT"];
    // Each side gets its own history directory so run ids never collide.
    env["NAT_HOME"] = mkdtempSync(join(tmpdir(), "nat-diff-home-"));
    env["NAT_SSH_BIN"] = FAKE_SSH;
    env["NAT_FAKE_DIR"] = this.replies;
    env["NAT_CREDENTIAL_BACKEND"] = "file";
    return env;
  }
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function equalText(actualRaw: string, expectedRaw: string, stream: string, label: string): void {
  const actual = normalize(actualRaw);
  const expected = normalize(expectedRaw);
  let first = 0;
  while (first < actual.length && first < expected.length && actual.charAt(first) === expected.charAt(first)) first += 1;
  assert.ok(
    actual === expected,
    `${stream} differs for ${label}: expected ${expected.length} bytes/${digest(expected)}, ` +
      `got ${actual.length}/${digest(actual)}, first difference at ${first}`,
  );
}

function bothAgree(lab: Lab, args: string[], input: string): void {
  const viaNode = spawnSync(process.execPath, [ENTRY, ...args], { encoding: "utf8", env: lab.env(), input });
  for (const binary of binaries) {
    const viaNative = spawnSync(binary, args, { encoding: "utf8", env: lab.env(), input });
    const label = `${binary}: ${args.join(" ")}`;
    equalText(viaNative.stdout, viaNode.stdout, "stdout", label);
    equalText(viaNative.stderr, viaNode.stderr, "stderr", label);
    assert.equal(viaNative.status, viaNode.status, `exit code differs for ${label}`);
  }
}

describe("compiled binary matches the sources under Node", { skip: available ? false : "dist/nat not built" }, () => {
  test("help and version", () => {
    const lab = new Lab();
    bothAgree(lab, ["--help"], "");
    bothAgree(lab, ["--version"], "");
    bothAgree(lab, ["run", "--help"], "");
  });

  test("argument errors", () => {
    const lab = new Lab();
    bothAgree(lab, ["run"], "");
    bothAgree(lab, ["run", "--definitely-not-a-flag"], "");
    bothAgree(lab, ["frobnicate"], "");
  });

  test("inventory", () => {
    const lab = new Lab();
    bothAgree(lab, ["--ssh-config", lab.config, "inventory", "list"], "");
    bothAgree(lab, ["--ssh-config", lab.config, "inventory", "show", "leaf1"], "");
  });

  test("offline parsing of piped input", () => {
    const lab = new Lab();
    bothAgree(lab, ["parse", "-c", "df -h", "--driver", "linux"], "Filesystem Size\n/dev/sda1 20G\n");
    bothAgree(lab, ["parse", "-c", "ip addr", "--driver", "linux", "--json"], "2: eth0: <UP> mtu 1500\n    inet 10.0.0.1/24 scope global eth0\n");
    const parser = join(mkdtempSync(join(tmpdir(), "nat-diff-parser-")), "parser.sh");
    writeFileSync(parser, "#!/bin/sh\ncat\n");
    chmodSync(parser, 0o700);
    bothAgree(lab, ["parse", "-c", "custom", "--driver", "linux", "--parser-cmd", parser, "--json"], "raw\n");
  });

  test("a run over exec channels", () => {
    const lab = new Lab();
    bothAgree(
      lab,
      ["--ssh-config", lab.config, "run", "web1", "-c", "uptime", "-c", "large", "-c", "ip addr", "--parse", "--json"],
      "",
    );
  });

  test("a run through an interactive session", () => {
    const lab = new Lab();
    bothAgree(lab, ["--ssh-config", lab.config, "run", "leaf1", "-c", "show version", "--parse", "--json"], "");
  });

  test("every parser fixture parses identically", () => {
    const lab = new Lab();
    const manifest = JSON.parse(
      readFixture("manifest.json"),
    ) as { driver: string; command: string; fixture: string }[];
    for (const entry of manifest) {
      bothAgree(lab, ["parse", "-c", entry.command, "--driver", entry.driver, "--json"], readFixture(entry.fixture));
    }
  });
});

function readFixture(name: string): string {
  return readFileSync(join(HERE, "fixtures", "parsers", name), "utf8");
}
