import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const ENTRY = join(ROOT, "cli", "nat.ts");
const FAKE_SSH = join(HERE, "fixtures", "fake-ssh");

class CliResult {
  code: number;
  stdout: string;
  stderr: string;

  constructor(code: number, stdout: string, stderr: string) {
    this.code = code;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

/** A scratch environment: its own config home, replies directory and ssh stub. */
class Lab {
  home: string;
  replies: string;
  config: string;

  constructor() {
    const base = mkdtempSync(join(tmpdir(), "nat-cli-"));
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
        "",
        "Host web2",
        "    HostName 10.0.1.2",
      ].join("\n") + "\n",
    );
  }

  reply(command: string, body: string): void {
    const slug = Array.from(command)
      .map((c) => (/[a-z0-9]/.test(c.toLowerCase()) ? c.toLowerCase() : "_"))
      .join("");
    writeFileSync(join(this.replies, `cmd_${slug}`), body);
  }

  run(args: string[]): CliResult {
    const result = spawnSync(process.execPath, [ENTRY, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        NAT_HOME: this.home,
        NAT_SSH_BIN: FAKE_SSH,
        NAT_FAKE_DIR: this.replies,
        NAT_CREDENTIAL_BACKEND: "file",
        NAT_SSH_PASSWORD: "",
      },
    });
    return new CliResult(result.status === null ? -1 : result.status, result.stdout, result.stderr);
  }
}

function cli(args: string[]): CliResult {
  const result = spawnSync(process.execPath, [ENTRY, ...args], { encoding: "utf8" });
  return new CliResult(result.status === null ? -1 : result.status, result.stdout, result.stderr);
}

describe("help and version", () => {
  test("--help prints the usage and exits 0", () => {
    const result = cli(["--help"]);
    assert.equal(result.code, 0);
    assert.ok(result.stdout.includes("nat inventory list"));
    // --raw changes what is collected, not just what is shown; the usage says so.
    assert.ok(result.stdout.includes("Affects what is collected and"));
  });

  test("run --help documents that output prints by default, and how to opt out", () => {
    const result = cli(["run", "--help"]);
    assert.ok(result.stdout.includes("Command output is printed when the run finishes"));
    assert.ok(result.stdout.includes("--quiet"));
    assert.ok(result.stdout.includes("nat results <run-id>"));
  });

  test("no arguments prints the usage and exits 2", () => {
    assert.equal(cli([]).code, 2);
  });

  test("--version prints just the version", () => {
    const result = cli(["--version"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /^nat \d+\.\d+\.\d+\n$/);
  });

  test("every subcommand has its own help", () => {
    for (const entry of [
      ["run", "nat run — run commands"],
      ["parse", "nat parse — run the parser chain"],
      ["inventory", "nat inventory"],
      ["cred", "nat cred"],
      ["watch", "nat watch"],
      ["results", "nat results"],
      ["runs", "nat runs"],
      ["doctor", "nat doctor"],
    ]) {
      const result = cli([entry[0], "--help"]);
      assert.equal(result.code, 0, entry[0]);
      assert.ok(result.stdout.includes(entry[1]), entry[0]);
    }
  });

  test("an unknown command is named", () => {
    const result = cli(["frobnicate"]);
    assert.notEqual(result.code, 0);
    assert.ok(result.stderr.includes("unknown command: frobnicate"));
  });
});

describe("nat run argument handling", () => {
  test("requires at least one host", () => {
    const result = cli(["run"]);
    assert.notEqual(result.code, 0);
    assert.ok(result.stderr.includes("run requires at least one host"));
  });

  test("treats only tokens before `--` as hosts", () => {
    const result = cli(["run", "--", "uptime"]);
    assert.ok(result.stderr.includes("run requires at least one host"));
  });

  test("errors when a host is given but no command", () => {
    const result = cli(["run", "somehost"]);
    assert.ok(result.stderr.includes("run requires at least one command"));
    assert.ok(result.stderr.includes("inline after"));
  });

  test("accepts --quiet and -q", () => {
    for (const flag of ["--quiet", "-q"]) {
      assert.ok(cli(["run", flag]).stderr.includes("run requires at least one host"));
    }
  });

  test("rejects an unknown flag by name", () => {
    const result = cli(["run", "--definitely-not-a-flag"]);
    assert.notEqual(result.code, 0);
    assert.ok(result.stderr.includes("unknown option: --definitely-not-a-flag"));
  });

  test("requires a value for the global ssh-config option", () => {
    const result = cli(["run", "web1", "--ssh-config"]);
    assert.notEqual(result.code, 0);
    assert.ok(result.stderr.includes("option --ssh-config requires a value"));
  });
});

describe("inventory", () => {
  test("lists aliases and shows a resolved host", () => {
    const lab = new Lab();
    const list = lab.run(["--ssh-config", lab.config, "inventory", "list"]);
    assert.equal(list.code, 0);
    assert.equal(list.stdout, "leaf1\nweb1\nweb2\n");

    const show = lab.run(["--ssh-config", lab.config, "inventory", "show", "leaf1"]);
    assert.ok(show.stdout.includes("hostname:     10.0.0.1"));
    assert.ok(show.stdout.includes("user:         admin"));
    assert.ok(!show.stdout.includes("driver:"), "the original inventory-show text contract is unchanged");
  });

  test("reports a missing config file", () => {
    const lab = new Lab();
    const result = lab.run(["--ssh-config", "/definitely/not/here", "inventory", "list"]);
    assert.notEqual(result.code, 0);
    assert.ok(result.stderr.includes("SSH config not found"));
  });
});

describe("end-to-end runs", () => {
  test("runs commands over exec channels and prints the output", () => {
    const lab = new Lab();
    lab.reply("uptime", "up 3 days\n");
    lab.reply("df -h", "Filesystem Size\n/dev/sda1 20G\n");

    const result = lab.run(["--ssh-config", lab.config, "run", "web1", "web2", "-c", "uptime", "-c", "df -h"]);
    assert.equal(result.code, 0);
    assert.ok(result.stdout.includes("=== web1 (10.0.1.1) [ok] ==="));
    assert.ok(result.stdout.includes("=== web2 (10.0.1.2) [ok] ==="));
    assert.ok(result.stdout.includes("$ uptime\nup 3 days"));
    assert.ok(result.stdout.includes("web1 (10.0.1.1): ok"));
  });

  test("a sonic host is driven through an interactive session", () => {
    const lab = new Lab();
    lab.reply("show version", "SONiC Software Version: 4.1.0\n");
    const result = lab.run(["--ssh-config", lab.config, "run", "leaf1", "-c", "show version", "--parse", "--json"]);
    assert.equal(result.code, 0);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.results.length, 1);
    assert.equal(envelope.results[0].hostAlias, "leaf1");
    assert.equal(envelope.results[0].platform, "sonic");
    // The echoed command and the trailing prompt are gone.
    assert.equal(envelope.results[0].commands[0].output, "SONiC Software Version: 4.1.0");
    assert.equal(envelope.results[0].commands[0].parsed.kind, "sonic.version");
  });

  test("inline commands after `--` run in order, before -c and --file", () => {
    const lab = new Lab();
    lab.reply("one", "1\n");
    lab.reply("two", "2\n");
    lab.reply("three", "3\n");
    const file = join(lab.home, "cmds.txt");
    writeFileSync(file, "# comment\nthree\n");

    const result = lab.run([
      "--ssh-config", lab.config, "run", "web1", "-c", "two", "--file", file, "--json", "--", "one",
    ]);
    const envelope = JSON.parse(result.stdout);
    assert.deepEqual(
      envelope.results[0].commands.map((c: { command: string }) => c.command),
      ["one", "two", "three"],
    );
  });

  test("global-looking tokens after -- remain literal commands", () => {
    const lab = new Lab();
    lab.reply("--ssh-config", "literal\n");
    const result = lab.run(["--ssh-config", lab.config, "run", "web1", "--json", "--", "--ssh-config"]);
    assert.equal(result.code, 0, result.stderr);
    const entry = JSON.parse(result.stdout).results[0].commands[0];
    assert.equal(entry.command, "--ssh-config");
    assert.equal(entry.output, "literal");
  });

  test("a conditional command is skipped when its predecessor does not match", () => {
    const lab = new Lab();
    lab.reply("show state", "Active\n");
    lab.reply("write memory", "saved\n");

    const taken = lab.run([
      "--ssh-config", lab.config, "run", "web1", "--json",
      "-c", "show state", "-c", "when contains:Active :: write memory",
    ]);
    assert.equal(JSON.parse(taken.stdout).results[0].commands.length, 2);

    const skipped = lab.run([
      "--ssh-config", lab.config, "run", "web1", "--json",
      "-c", "show state", "-c", "when contains:Standby :: write memory",
    ]);
    assert.equal(JSON.parse(skipped.stdout).results[0].commands.length, 1);
  });

  test("a failing host is reported and sets a non-zero exit code", () => {
    const lab = new Lab();
    const result = lab.run(["--ssh-config", lab.config, "run", "web1", "-c", "uptime", "--json"]);
    // No reply file exists, so the fake device answers "not found" on stderr;
    // that is command output, not a connection failure — the run still succeeds.
    assert.equal(result.code, 0);
    assert.ok(JSON.parse(result.stdout).results[0].commands[0].output.includes("not found"));
  });

  test("an authentication failure is reported per host", () => {
    const lab = new Lab();
    const result = spawnSync(process.execPath, [ENTRY, "--ssh-config", lab.config, "run", "web1", "-c", "uptime", "--json"], {
      encoding: "utf8",
      env: { ...process.env, NAT_HOME: lab.home, NAT_SSH_BIN: FAKE_SSH, NAT_FAKE_DIR: lab.replies, NAT_FAKE_AUTH_FAIL: "1" },
    });
    assert.equal(result.status, 1);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.results[0].success, false);
    assert.ok(envelope.results[0].error.includes("authentication failed"));
  });

  test("a declarative parser pack overrides the built-ins", () => {
    const lab = new Lab();
    lab.reply("show version", "Version: 9.9.9\n");
    const pack = join(lab.home, "pack.json");
    writeFileSync(pack, JSON.stringify({ sonic: { "show version": { kind: "custom", fields: { v: { pattern: "Version:\\s*(\\S+)" } } } } }));

    const result = lab.run(["--ssh-config", lab.config, "run", "leaf1", "-c", "show version", "--parsers", pack, "--json"]);
    const parsed = JSON.parse(result.stdout).results[0].commands[0].parsed;
    assert.deepEqual(parsed, { kind: "custom", v: "9.9.9" });
  });
});

describe("run history", () => {
  test("a run is replayable through runs, results and watch", () => {
    const lab = new Lab();
    lab.reply("uptime", "up 3 days\n");
    const run = lab.run(["--ssh-config", lab.config, "run", "web1", "-c", "uptime"]);
    const runId = /run_id: (\w+)/.exec(run.stdout);
    assert.ok(runId !== null);

    const runs = lab.run(["runs"]);
    assert.ok(runs.stdout.includes(runId[1]));
    assert.ok(runs.stdout.includes("completed"));

    const byHost = lab.run(["runs", "--host", "web1"]);
    assert.ok(byHost.stdout.includes(runId[1]));
    assert.equal(lab.run(["runs", "--host", "nobody"]).stdout, "(no runs recorded)\n");

    const results = lab.run(["results", runId[1]]);
    assert.ok(results.stdout.includes("$ uptime\nup 3 days"));

    const watch = lab.run(["watch", runId[1]]);
    assert.ok(watch.stdout.includes("host_start"));
    assert.ok(watch.stdout.includes("host_complete"));

    const json = lab.run(["results", runId[1], "--json"]);
    const stored = JSON.parse(json.stdout).results[0];
    assert.equal(stored.commands[0].output, "up 3 days");
    assert.match(stored.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  });

  test("--no-store leaves no run behind", () => {
    const lab = new Lab();
    lab.reply("uptime", "up\n");
    lab.run(["--ssh-config", lab.config, "run", "web1", "-c", "uptime", "--no-store"]);
    assert.equal(lab.run(["runs"]).stdout, "(no runs recorded)\n");
  });

  test("an unknown run id is reported", () => {
    const lab = new Lab();
    const result = lab.run(["results", "deadbeef"]);
    assert.notEqual(result.code, 0);
    assert.ok(result.stderr.includes("unknown run-id: deadbeef"));
  });
});

describe("offline parsing", () => {
  test("parses piped output with a built-in parser", () => {
    const result = spawnSync(process.execPath, [ENTRY, "parse", "-c", "df -h", "--driver", "linux", "--json"], {
      encoding: "utf8",
      input: "Filesystem Size Used\n/dev/sda1 20G 5G\n",
    });
    assert.equal(result.status, 0);
    const parsed = JSON.parse(result.stdout);
    assert.deepEqual(parsed.columns, ["filesystem", "size", "used"]);
    assert.equal(parsed.rows[0].filesystem, "/dev/sda1");
  });

  test("reads a fixture file and pretty-prints by default", () => {
    const dir = mkdtempSync(join(tmpdir(), "nat-parse-"));
    const file = join(dir, "out.txt");
    writeFileSync(file, "Key: Value\n");
    const result = cli(["parse", "-c", "anything", "-i", file]);
    assert.equal(result.code, 0);
    assert.ok(result.stdout.includes('  "fields": {'));
  });

  test("requires --command", () => {
    const result = cli(["parse"]);
    assert.notEqual(result.code, 0);
    assert.ok(result.stderr.includes("parse requires --command"));
  });
});

describe("credentials", () => {
  test("stores, reads and deletes a secret in the file backend", () => {
    const lab = new Lab();
    const set = lab.run(["cred", "set", "leaf1", "--user", "admin", "--secret", "hunter2"]);
    assert.equal(set.code, 0);
    assert.ok(set.stdout.includes("stored password for admin@leaf1"));

    assert.equal(lab.run(["cred", "get", "leaf1", "--user", "admin"]).stdout, "(secret present)\n");

    const removed = lab.run(["cred", "delete", "leaf1", "--user", "admin"]);
    assert.ok(removed.stdout.includes("deleted password"));
    assert.equal(lab.run(["cred", "get", "leaf1", "--user", "admin"]).code, 1);
  });

  test("refuses an empty secret", () => {
    const lab = new Lab();
    const result = lab.run(["cred", "set", "leaf1", "--user", "admin", "--secret", "   "]);
    assert.notEqual(result.code, 0);
  });

  test("requires a user it cannot infer", () => {
    const lab = new Lab();
    const result = lab.run(["cred", "set", "web2"]);
    assert.notEqual(result.code, 0);
    assert.ok(result.stderr.includes("could not determine user"));
  });
});

describe("doctor", () => {
  test("rejects a misspelled forced credential backend instead of silently using plaintext", () => {
    const result = spawnSync(process.execPath, [ENTRY, "doctor"], {
      encoding: "utf8",
      env: { ...process.env, NAT_HOME: mkdtempSync(join(tmpdir(), "nat-doctor-")), NAT_CREDENTIAL_BACKEND: "fil" },
    });
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes("invalid NAT_CREDENTIAL_BACKEND"));
  });

  test("reports the ssh client, secret store and history location", () => {
    const lab = new Lab();
    const result = lab.run(["--ssh-config", lab.config, "doctor"]);
    assert.equal(result.code, 0);
    assert.ok(result.stdout.includes("ssh client:"));
    assert.ok(result.stdout.includes("secret store:"));
    assert.ok(result.stdout.includes("run history:"));
    assert.ok(result.stdout.includes("host aliases: 3"));
  });
});
