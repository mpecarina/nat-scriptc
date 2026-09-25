import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

import { HostConfig } from "../src/models.ts";
import { RunOptions, effectiveDriver, execTextForDriver, shouldEnterSonicCli, shouldUseIosShell } from "../src/runner.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const ENTRY = join(ROOT, "cli", "nat.ts");
const FAKE_SSH = join(HERE, "fixtures", "fake-ssh");

function host(alias: string, driver: string): HostConfig {
  const config = new HostConfig(alias);
  config.hostname = `10.0.0.1`;
  config.targetOs = driver;
  return config;
}

describe("driver selection", () => {
  test("--driver wins over the host's own, which wins over the default", () => {
    const options = new RunOptions();
    assert.equal(effectiveDriver(host("h", ""), options), "generic");
    assert.equal(effectiveDriver(host("h", "SONiC"), options), "sonic");
    options.driver = "Linux";
    assert.equal(effectiveDriver(host("h", "sonic"), options), "linux");
  });

  test("a sonic host enters sonic-cli; --no-sonic-cli always wins", () => {
    const options = new RunOptions();
    assert.equal(shouldEnterSonicCli(host("h", "sonic"), options), true);
    assert.equal(shouldEnterSonicCli(host("h", "linux"), options), false);
    options.enterSonicCli = true;
    assert.equal(shouldEnterSonicCli(host("h", "linux"), options), true);
    options.noSonicCli = true;
    assert.equal(shouldEnterSonicCli(host("h", "sonic"), options), false);
  });

  test("the Cisco drivers use an interactive session unless disabled", () => {
    const options = new RunOptions();
    assert.equal(shouldUseIosShell(host("h", "ios"), options), true);
    assert.equal(shouldUseIosShell(host("h", "nxos"), options), true);
    assert.equal(shouldUseIosShell(host("h", "eos"), options), false);
    options.noIosShell = true;
    assert.equal(shouldUseIosShell(host("h", "ios"), options), false);
  });
});

describe("VyOS op-mode wrapping", () => {
  test("wraps a bare op-mode verb", () => {
    assert.equal(
      execTextForDriver("vyos", "show ip route"),
      "/opt/vyatta/bin/vyatta-op-cmd-wrapper show ip route",
    );
  });

  test("leaves other drivers, shell lines and already-wrapped commands alone", () => {
    assert.equal(execTextForDriver("linux", "show ip route"), "show ip route");
    assert.equal(execTextForDriver("vyos", "cat /etc/os-release"), "cat /etc/os-release");
    assert.equal(execTextForDriver("vyos", "show interfaces | grep eth0"), "show interfaces | grep eth0");
    assert.equal(
      execTextForDriver("vyos", "/opt/vyatta/bin/vyatta-op-cmd-wrapper show version"),
      "/opt/vyatta/bin/vyatta-op-cmd-wrapper show version",
    );
  });
});

class Lab {
  home: string;
  replies: string;
  config: string;
  log: string;

  constructor(configText: string) {
    const base = mkdtempSync(join(tmpdir(), "nat-runner-"));
    this.home = join(base, "home");
    this.replies = join(base, "replies");
    this.config = join(base, "ssh_config");
    this.log = join(base, "argv.log");
    mkdirSync(this.home, { recursive: true });
    mkdirSync(this.replies, { recursive: true });
    writeFileSync(this.config, configText);
  }

  reply(command: string, body: string): void {
    const slug = Array.from(command)
      .map((c) => (/[a-z0-9]/.test(c.toLowerCase()) ? c.toLowerCase() : "_"))
      .join("");
    writeFileSync(join(this.replies, `cmd_${slug}`), body);
  }

  run(args: string[], extra: Record<string, string>) {
    const env: Record<string, string> = {};
    for (const key of Object.keys(process.env)) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    env["NAT_HOME"] = this.home;
    env["NAT_SSH_BIN"] = FAKE_SSH;
    env["NAT_FAKE_DIR"] = this.replies;
    env["NAT_FAKE_LOG"] = this.log;
    for (const key of Object.keys(extra)) env[key] = extra[key];
    return spawnSync(process.execPath, [ENTRY, ...args], { encoding: "utf8", env });
  }

  argv(): string {
    try {
      return readFileSync(this.log, "utf8");
    } catch (err) {
      return "";
    }
  }
}

const CONFIG = [
  "Host bastion",
  "    HostName 10.0.9.1",
  "    User jump",
  "",
  "Host leaf1",
  "    HostName 10.0.0.1",
  "    User admin",
  "    ProxyJump bastion",
  "",
  "Host router1",
  "    HostName 10.0.2.1",
  "    #nat-driver ios",
  "",
  "Host vyos1",
  "    HostName 10.0.3.1",
  "    #nat-driver vyos",
].join("\n") + "\n";

describe("transport paths", () => {
  test("a configured ProxyJump stays in ssh_config", () => {
    const lab = new Lab(CONFIG);
    lab.reply("show version", "Version 1.2.3\n");
    const result = lab.run(["--ssh-config", lab.config, "run", "leaf1", "-c", "show version", "--json"], {});
    assert.equal(result.status, 0);
    const argv = lab.argv();
    assert.ok(argv.includes(`-F ${lab.config}`));
    assert.ok(argv.includes("leaf1"), "the alias lets ssh apply Host leaf1 and its ProxyJump/User");
    assert.ok(!argv.includes("-J bastion"), "config values are not re-spelled as overriding argv options");
  });

  test("ProxyJump and target use their own stored passwords", () => {
    const lab = new Lab(CONFIG);
    lab.reply("uptime", "up 3 days\n");
    const credentialEnv = { NAT_CREDENTIAL_BACKEND: "file" };
    assert.equal(
      lab.run(
        ["--ssh-config", lab.config, "cred", "set", "bastion", "--user", "jump", "--secret", "jump-secret"],
        credentialEnv,
      ).status,
      0,
    );
    assert.equal(
      lab.run(
        ["--ssh-config", lab.config, "cred", "set", "leaf1", "--user", "admin", "--secret", "target-secret"],
        credentialEnv,
      ).status,
      0,
    );

    const result = lab.run(
      ["--ssh-config", lab.config, "run", "leaf1", "-c", "uptime", "--json"],
      {
        NAT_CREDENTIAL_BACKEND: "file",
        NAT_FAKE_JUMP_HOST: "bastion",
        NAT_FAKE_JUMP_PASSWORD: "jump-secret",
        NAT_FAKE_PASSWORD: "target-secret",
        NAT_SSH_PASSWORD: "",
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).results[0].commands[0].output, "up 3 days");
  });

  test("an explicit --jump uses the override host's stored password", () => {
    const config = CONFIG + ["", "Host emergency", "    HostName 10.0.9.9", "    User rescue"].join("\n") + "\n";
    const lab = new Lab(config);
    lab.reply("uptime", "up 3 days\n");
    const credentialEnv = { NAT_CREDENTIAL_BACKEND: "file" };
    assert.equal(
      lab.run(
        ["--ssh-config", lab.config, "cred", "set", "emergency", "--user", "rescue", "--secret", "override-secret"],
        credentialEnv,
      ).status,
      0,
    );
    assert.equal(
      lab.run(
        ["--ssh-config", lab.config, "cred", "set", "leaf1", "--user", "admin", "--secret", "target-secret"],
        credentialEnv,
      ).status,
      0,
    );

    const result = lab.run(
      ["--ssh-config", lab.config, "run", "leaf1", "--jump", "emergency", "-c", "uptime", "--json"],
      {
        NAT_CREDENTIAL_BACKEND: "file",
        NAT_FAKE_JUMP_HOST: "emergency",
        NAT_FAKE_JUMP_PASSWORD: "override-secret",
        NAT_FAKE_PASSWORD: "target-secret",
        NAT_SSH_PASSWORD: "",
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).results[0].commands[0].output, "up 3 days");
  });

  test("Port and IdentityFile stay in ssh_config for ssh token expansion", () => {
    const config = CONFIG + ["", "Host tokenized", "    HostName 10.0.4.1", "    Port 2222", "    IdentityFile none"].join("\n") + "\n";
    const lab = new Lab(config);
    lab.reply("uptime", "up 3 days\n");
    const result = lab.run(["--ssh-config", lab.config, "run", "tokenized", "-c", "uptime"], {});
    assert.equal(result.status, 0);
    const argv = lab.argv();
    assert.ok(argv.includes(`-F ${lab.config}`));
    assert.ok(!argv.includes("-p 2222"));
    assert.ok(!argv.includes("-i none"));
  });

  test("--jump overrides the configured ProxyJump", () => {
    const lab = new Lab(CONFIG);
    lab.reply("show version", "Version 1.2.3\n");
    lab.run(["--ssh-config", lab.config, "run", "leaf1", "--jump", "other", "-c", "show version", "--json"], {});
    assert.ok(lab.argv().includes("-J other"));
    assert.ok(!lab.argv().includes("-J bastion"));
  });

  test("--jump-shell tunnels through the jump host's own session", () => {
    const lab = new Lab(CONFIG);
    lab.reply("show version", "Version 1.2.3\n");
    const result = lab.run(["--ssh-config", lab.config, "run", "leaf1", "--jump-shell", "-c", "show version", "--json"], {});
    assert.equal(result.status, 0);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.results[0].commands[0].output, "Version 1.2.3");
    // The connection is made to the jump host — ssh resolves the alias from the
    // same config — and the target is reached by typing ssh into that session.
    assert.ok(lab.argv().includes("bastion"), "the jump alias reaches ssh for full config resolution");
    assert.ok(!lab.argv().includes("10.0.9.1"), "nat does not bypass the jump host's Host block");
  });

  test("--jump-shell accepts a target whose prompt matches the jump host", () => {
    const lab = new Lab(CONFIG);
    lab.reply("show version", "Version 1.2.3\n");
    const result = lab.run(
      ["--ssh-config", lab.config, "run", "leaf1", "--jump-shell", "-c", "show version", "--json"],
      { NAT_FAKE_NESTED_PROMPT: "dev1$ " },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).results[0].commands[0].output, "Version 1.2.3");
  });

  test("--jump-shell honours an explicit jump user and port", () => {
    const lab = new Lab(CONFIG);
    lab.reply("show version", "Version 1.2.3\n");
    const result = lab.run(
      ["--ssh-config", lab.config, "run", "leaf1", "--jump", "ops@bastion:2200", "--jump-shell", "-c", "show version", "--json"],
      {},
    );
    assert.equal(result.status, 0);
    const argv = lab.argv();
    assert.ok(argv.includes("-p 2200"));
    assert.ok(argv.includes("ops@bastion"));
  });

  test("--jump-shell without a jump host is refused", () => {
    const lab = new Lab(CONFIG);
    const result = lab.run(["--ssh-config", lab.config, "run", "router1", "--jump-shell", "-c", "x", "--json"], {});
    const envelope = JSON.parse(result.stdout);
    assert.ok(envelope.results[0].error.includes("--jump-shell requires a jump host"));
  });

  test("an ios host is driven through an interactive session", () => {
    const lab = new Lab(CONFIG);
    lab.reply("show ip interface brief", "Interface IP-Address OK? Method Status Protocol\nGi1 10.0.2.1 YES NVRAM up up\n");
    const result = lab.run(
      ["--ssh-config", lab.config, "run", "router1", "-c", "show ip interface brief", "--parse", "--json"],
      {},
    );
    assert.equal(result.status, 0);
    const parsed = JSON.parse(result.stdout).results[0].commands[0].parsed;
    assert.equal(parsed.kind, "ios.ipInterfaces");
    assert.equal(parsed.interfaces[0].name, "Gi1");
    assert.ok(lab.argv().includes("-tt"), "the ios path asks for a terminal");
  });

  test("a multiline IOS block is sent line by line and stored without echoes", () => {
    const lab = new Lab(CONFIG);
    lab.reply("configure terminal", "");
    lab.reply("interface GigabitEthernet1", "");
    lab.reply("description uplink", "accepted\n");
    lab.reply("end", "");
    const command = "configure terminal\ninterface GigabitEthernet1\ndescription uplink\nend";
    const result = lab.run(["--ssh-config", lab.config, "run", "router1", "-c", command, "--json"], {});
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).results[0].commands[0].output, "accepted");
  });

  test("--no-ios-shell puts the same host back on exec channels", () => {
    const lab = new Lab(CONFIG);
    lab.reply("show version", "Cisco IOS XE Software, Version 17.03.05\n");
    const result = lab.run(
      ["--ssh-config", lab.config, "run", "router1", "--no-ios-shell", "-c", "show version", "--json"],
      {},
    );
    assert.equal(result.status, 0);
    assert.ok(!lab.argv().includes("-tt"));
  });

  test("a vyos op-mode verb is wrapped on the wire but recorded bare", () => {
    const lab = new Lab(CONFIG);
    // The reply is keyed on the WRAPPED command, so a match proves the wrapping.
    lab.reply("/opt/vyatta/bin/vyatta-op-cmd-wrapper show ip route", "C>* 10.0.0.0/24 is directly connected, eth0\n");
    const result = lab.run(["--ssh-config", lab.config, "run", "vyos1", "-c", "show ip route", "--parse", "--json"], {});
    assert.equal(result.status, 0);
    const entry = JSON.parse(result.stdout).results[0].commands[0];
    assert.equal(entry.command, "show ip route", "run history keeps the bare verb");
    assert.equal(entry.parsed.routes[0].prefix, "10.0.0.0/24", "and --parse still selects the vyos parser");
  });

  test("--user is the only login user re-spelled on argv", () => {
    const lab = new Lab(CONFIG);
    lab.reply("show version", "Version 1.2.3\n");
    const result = lab.run(
      ["--ssh-config", lab.config, "run", "router1", "--user", "neteng", "--no-ios-shell", "-c", "show version"],
      {},
    );
    assert.equal(result.status, 0);
    assert.ok(lab.argv().includes("neteng@router1"));
  });

  test("--user selects that account's stored password", () => {
    const lab = new Lab(CONFIG);
    lab.reply("uptime", "up 3 days\n");
    const stored = lab.run(
      ["--ssh-config", lab.config, "cred", "set", "leaf1", "--user", "neteng", "--secret", "hunter2"],
      { NAT_CREDENTIAL_BACKEND: "file" },
    );
    assert.equal(stored.status, 0);

    const result = lab.run(
      ["--ssh-config", lab.config, "run", "leaf1", "--user", "neteng", "-c", "uptime", "--json"],
      { NAT_CREDENTIAL_BACKEND: "file", NAT_FAKE_PASSWORD: "hunter2", NAT_SSH_PASSWORD: "" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).results[0].commands[0].output, "up 3 days");
  });

  test("--no-multiplex asks ssh for no control socket", () => {
    const lab = new Lab(CONFIG);
    lab.reply("show version", "Version 1.2.3\n");
    lab.run(["--ssh-config", lab.config, "run", "router1", "--no-multiplex", "--no-ios-shell", "-c", "show version"], {});
    assert.ok(!lab.argv().includes("ControlPath="));
  });

  test("--ssh-option and --host-key-checking reach ssh", () => {
    const lab = new Lab(CONFIG);
    lab.reply("show version", "Version 1.2.3\n");
    lab.run(
      [
        "--ssh-config", lab.config, "run", "router1", "--no-ios-shell",
        "--host-key-checking", "no", "--ssh-option", "Ciphers=aes128-ctr", "-c", "show version",
      ],
      {},
    );
    const argv = lab.argv();
    assert.ok(argv.includes("StrictHostKeyChecking=no"));
    assert.ok(argv.includes("Ciphers=aes128-ctr"));
  });

  test("--watch streams events while the run is in flight", () => {
    const lab = new Lab(CONFIG);
    lab.reply("show version", "Version 1.2.3\n");
    const result = lab.run(
      ["--ssh-config", lab.config, "run", "router1", "--no-ios-shell", "--watch", "-c", "show version"],
      {},
    );
    assert.equal(result.status, 0);
    assert.ok(result.stdout.includes("host_start"));
    assert.ok(result.stdout.includes("command_output"));
    assert.ok(result.stdout.includes("host_complete"));
  });

  test("--ask-pass prompts on stderr and keeps stdout clean for --json", () => {
    const lab = new Lab(CONFIG);
    lab.reply("show version", "Version 1.2.3\n");
    const env: Record<string, string> = { NAT_FAKE_PASSWORD: "hunter2" };
    const result = spawnSync(
      process.execPath,
      [ENTRY, "--ssh-config", lab.config, "run", "router1", "--no-ios-shell", "--ask-pass", "-c", "show version", "--json"],
      {
        encoding: "utf8",
        input: "hunter2\n",
        env: {
          ...process.env,
          NAT_HOME: lab.home,
          NAT_SSH_BIN: FAKE_SSH,
          NAT_FAKE_DIR: lab.replies,
          NAT_FAKE_LOG: lab.log,
          ...env,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stderr.includes("SSH password:"), "the prompt goes to stderr");
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.results[0].commands[0].output, "Version 1.2.3");
    assert.ok(!lab.argv().includes("hunter2"), "the secret never rides an argv");
  });
});

describe("JSON inventories", () => {
  test("runs against a JSON lab inventory, driver and password included", () => {
    const lab = new Lab(CONFIG);
    lab.reply("show version", "SONiC Software Version: 4.1.0\n");
    const inventory = join(lab.home, "inventory.json");
    writeFileSync(
      inventory,
      JSON.stringify({
        devices: [
          { id: "leafA", mgmtIp: "10.20.0.1", sshUser: "admin", driver: "sonic", password: "hunter2" },
          { id: "broken" },
        ],
      }),
    );

    const result = lab.run(
      ["run", "leafA", "--inventory", inventory, "-c", "show version", "--parse", "--json"],
      { NAT_FAKE_PASSWORD: "hunter2" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stderr.includes("inventory skipped 'broken'"));
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.results[0].hostname, "10.20.0.1");
    assert.equal(envelope.results[0].platform, "sonic");
    assert.equal(envelope.results[0].commands[0].parsed.kind, "sonic.version");
  });

  test("an inventory with no usable host is an error, not an empty run", () => {
    const lab = new Lab(CONFIG);
    const inventory = join(lab.home, "empty.json");
    writeFileSync(inventory, JSON.stringify({ devices: [{ id: "no-ip" }] }));
    const result = lab.run(["run", "--all", "--inventory", inventory, "-c", "x"], {});
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes("has no usable hosts"));
  });
});
