import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";

import { HostConfig } from "../src/models.ts";
import { ProcessResult } from "../src/process.ts";
import {
  ConnectionError,
  ConnectionTarget,
  SshConnection,
  TransportOptions,
  TransportWorkspace,
  connectErrorMessage,
  resolveEffectiveHost,
  splitJumpSpec,
} from "../src/transport.ts";
import { enterSonicCli, openShell, runShellCommand } from "../src/session.ts";
import { stripCommandEcho } from "../src/output.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_SSH = join(HERE, "fixtures", "fake-ssh");

/** A replies directory the fake device answers from. */
function replies(entries: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "nat-replies-"));
  for (const command of Object.keys(entries)) {
    const slug = Array.from(command)
      .map((c) => (/[a-z0-9]/.test(c.toLowerCase()) ? c.toLowerCase() : "_"))
      .join("");
    writeFileSync(join(dir, `cmd_${slug}`), entries[command]);
  }
  return dir;
}

function transportFor(dir: string): TransportOptions {
  const options = new TransportOptions();
  options.sshBin = FAKE_SSH;
  options.connectTimeout = 5;
  return options;
}

function targetFor(alias: string): ConnectionTarget {
  const host = new HostConfig(alias);
  host.hostname = "10.0.0.1";
  host.user = "admin";
  return new ConnectionTarget(host);
}

const workspaces: TransportWorkspace[] = [];
function workspace(): TransportWorkspace {
  const ws = new TransportWorkspace();
  workspaces.push(ws);
  return ws;
}

after(() => {
  for (const ws of workspaces) ws.dispose();
});

describe("connection failure messages", () => {
  test("names the methods tried and how to add one", () => {
    const target = targetFor("leaf1");
    const result = new ProcessResult();
    result.stderr = "leaf1: Permission denied (publickey,password).";
    const message = connectErrorMessage(target, result);
    assert.ok(message.startsWith("Failed connecting to leaf1: authentication failed"));
    assert.ok(message.includes("nat cred set leaf1"));
  });

  test("passes a non-auth failure through verbatim", () => {
    const result = new ProcessResult();
    result.stderr = "ssh: connect to host 10.0.0.1 port 22: Connection refused";
    assert.equal(
      connectErrorMessage(targetFor("leaf1"), result),
      "Failed connecting to leaf1: ssh: connect to host 10.0.0.1 port 22: Connection refused",
    );
  });

  test("reports a missing ssh binary as such", () => {
    const result = new ProcessResult();
    result.spawnError = "spawn ssh ENOENT";
    assert.ok(connectErrorMessage(targetFor("leaf1"), result).includes("cannot run ssh"));
  });
});

describe("jump specifications", () => {
  test("splits and trims a ProxyJump chain", () => {
    assert.deepEqual(splitJumpSpec("a, b ,c"), ["a", "b", "c"]);
    assert.deepEqual(splitJumpSpec(""), []);
  });
});

describe("system ssh_config resolution", () => {
  test("uses OpenSSH for Match exec and its defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "nat-ssh-g-"));
    const configPath = join(dir, "config");
    writeFileSync(
      configPath,
      [
        "Host audit",
        "    HostName 192.0.2.44",
        "    #nat-driver sonic",
        "    IdentityFile none",
        'Match originalhost audit exec "test x = x"',
        "    User matched-user",
        "    Port 2207",
        "Host default-audit",
        "    HostName 192.0.2.45",
      ].join("\n") + "\n",
    );

    const options = new TransportOptions();
    options.configPath = configPath;
    const parsed = new HostConfig("audit");
    parsed.hostname = "192.0.2.44";
    parsed.targetOs = "sonic";

    const effective = resolveEffectiveHost(options, parsed, "", -1, "");
    assert.equal(effective.hostname, "192.0.2.44");
    assert.equal(effective.user, "matched-user");
    assert.equal(effective.port, 2207);
    assert.deepEqual(effective.identityFiles, []);
    assert.equal(effective.targetOs, "sonic", "the driver survives OpenSSH resolution");

    const defaultUser = resolveEffectiveHost(options, new HostConfig("default-audit"), "", -1, "");
    assert.equal(defaultUser.user, userInfo().username, "OpenSSH supplies the implicit local login user");
  });

  test("an ssh without -G is a connection error, not a guess", () => {
    const options = new TransportOptions();
    options.sshBin = join(tmpdir(), "nat-no-such-ssh-g");
    assert.throws(() => resolveEffectiveHost(options, new HostConfig("audit"), "", -1, ""), ConnectionError);
  });
});

describe("multiplexed transport", () => {
  test("opens a master, runs commands over it, then tears it down", async () => {
    const dir = replies({ "show version": "Version 1.2.3\n" });
    const ws = workspace();
    const connection = new SshConnection(transportFor(dir), ws, targetFor("leaf1"));
    process.env["NAT_FAKE_DIR"] = dir;

    await connection.open();
    assert.notEqual(connection.controlPath, "");
    assert.ok(existsSync(connection.controlPath), "the control socket appears once auth succeeds");

    const result = await connection.exec("show version", 10);
    assert.equal(result.code, 0);
    assert.equal(result.output, "Version 1.2.3\n");

    connection.close();
  });

  test("keeps its private multiplex settings ahead of conflicting extra options", async () => {
    const dir = replies({ uptime: "up 3 days\n" });
    process.env["NAT_FAKE_DIR"] = dir;
    const logPath = join(mkdtempSync(join(tmpdir(), "nat-log-")), "argv.log");
    process.env["NAT_FAKE_LOG"] = logPath;
    const options = transportFor(dir);
    options.extraOptions.push("ControlPath=/tmp/nat-user-control-path");
    options.extraOptions.push("ControlPersist=yes");
    const connection = new SshConnection(options, workspace(), targetFor("leaf1"));

    await connection.open();
    assert.ok(existsSync(connection.controlPath));
    assert.equal((await connection.exec("uptime", 10)).output, "up 3 days\n");
    connection.close();

    const master = readFileSync(logPath, "utf8").split("\n").find((line) => line.includes(" -M ")) ?? "";
    assert.ok(master.indexOf(`ControlPath=${connection.controlPath}`) < master.indexOf("ControlPath=/tmp/nat-user-control-path"));
    assert.ok(master.indexOf("ControlPersist=no") < master.indexOf("ControlPersist=yes"));
    delete process.env["NAT_FAKE_LOG"];
  });

  test("reports a genuinely missing ssh executable through open()", async () => {
    const options = new TransportOptions();
    options.sshBin = join(tmpdir(), "nat-ssh-that-does-not-exist");
    options.connectTimeout = 1;
    const connection = new SshConnection(options, workspace(), targetFor("leaf1"));
    await assert.rejects(() => connection.open(), /cannot run ssh/);
  });

  test("uses the inventory alias so ssh still applies its Host block", async () => {
    const dir = replies({ uptime: "up 3 days\n" });
    const logPath = join(mkdtempSync(join(tmpdir(), "nat-log-")), "argv.log");
    process.env["NAT_FAKE_DIR"] = dir;
    process.env["NAT_FAKE_LOG"] = logPath;

    const connection = new SshConnection(transportFor(dir), workspace(), targetFor("leaf1"));
    await connection.open();
    await connection.exec("uptime", 10);
    connection.close();

    const argv = readFileSync(logPath, "utf8");
    assert.ok(argv.includes("leaf1"), "the original alias is the ssh destination");
    assert.ok(!argv.includes("10.0.0.1"), "resolved User/HostName values do not bypass Host leaf1 options");
    delete process.env["NAT_FAKE_LOG"];
  });

  test("a refused login raises a ConnectionError before any command runs", async () => {
    const dir = replies({});
    process.env["NAT_FAKE_DIR"] = dir;
    process.env["NAT_FAKE_AUTH_FAIL"] = "1";
    const connection = new SshConnection(transportFor(dir), workspace(), targetFor("leaf1"));
    await assert.rejects(() => connection.open(), ConnectionError);
    await assert.rejects(() => connection.open(), /authentication failed/);
    delete process.env["NAT_FAKE_AUTH_FAIL"];
  });

  test("a stored password reaches ssh through the askpass helper, never an argv", async () => {
    const dir = replies({ uptime: "up 3 days\n" });
    process.env["NAT_FAKE_DIR"] = dir;
    process.env["NAT_FAKE_PASSWORD"] = "hunter2";
    const logPath = join(mkdtempSync(join(tmpdir(), "nat-log-")), "argv.log");
    process.env["NAT_FAKE_LOG"] = logPath;

    const target = targetFor("leaf1");
    target.password = "hunter2";
    const connection = new SshConnection(transportFor(dir), workspace(), target);
    await connection.open();
    const result = await connection.exec("uptime", 10);
    assert.equal(result.output, "up 3 days\n");
    connection.close();

    const argv = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
    assert.ok(argv.length > 0, "the fake client recorded its arguments");
    assert.ok(!argv.includes("hunter2"), "the secret never appears in an argv");

    delete process.env["NAT_FAKE_PASSWORD"];
    delete process.env["NAT_FAKE_LOG"];
  });

  test("a wrong password fails authentication", async () => {
    const dir = replies({});
    process.env["NAT_FAKE_DIR"] = dir;
    process.env["NAT_FAKE_PASSWORD"] = "hunter2";
    const target = targetFor("leaf1");
    target.password = "wrong";
    const connection = new SshConnection(transportFor(dir), workspace(), target);
    await assert.rejects(() => connection.open(), /authentication failed/);
    delete process.env["NAT_FAKE_PASSWORD"];
  });

  test("disposing a workspace closes unowned sessions before removing their files", async () => {
    const dir = replies({});
    process.env["NAT_FAKE_DIR"] = dir;
    const ws = workspace();
    const connection = new SshConnection(transportFor(dir), ws, targetFor("leaf1"));
    await connection.open();
    const start = await openShell(connection, 100);
    assert.ok(existsSync(ws.dir));
    ws.dispose();
    assert.equal(start.channel.closed, true);
    assert.equal(existsSync(ws.dir), false);
  });
});

describe("interactive sessions", () => {
  test("reads the banner prompt, echoes commands, and follows a CLI change", async () => {
    const dir = replies({ "show version": "Version 1.2.3\nUptime 4 days\n" });
    process.env["NAT_FAKE_DIR"] = dir;
    const connection = new SshConnection(transportFor(dir), workspace(), targetFor("leaf1"));
    await connection.open();

    const start = await openShell(connection, 300);
    assert.equal(start.prompt, "dev1$");

    const sonic = await enterSonicCli(start.channel, start.prompt, 5);
    assert.equal(sonic.prompt, "sonic1#");

    const raw = await runShellCommand(start.channel, "show version", sonic.prompt, 10);
    assert.ok(raw.includes("show version\r\n"), "the remote pty echoes the command back");
    assert.equal(stripCommandEcho("show version", raw), "Version 1.2.3\nUptime 4 days");

    start.channel.end();
    connection.close();
  });

  test("stdin is incremental, so a later command sees the earlier one's state", async () => {
    const dir = replies({ one: "first\n", two: "second\n" });
    process.env["NAT_FAKE_DIR"] = dir;
    const connection = new SshConnection(transportFor(dir), workspace(), targetFor("leaf1"));
    await connection.open();
    const start = await openShell(connection, 300);

    const first = await runShellCommand(start.channel, "one", start.prompt, 10);
    assert.equal(stripCommandEcho("one", first), "first");
    const second = await runShellCommand(start.channel, "two", start.prompt, 10);
    assert.equal(stripCommandEcho("two", second), "second");

    start.channel.end();
    connection.close();
  });
});

describe("single-connection transport", () => {
  test("--no-multiplex runs each command on its own connection", async () => {
    const dir = replies({ uptime: "up 3 days\n" });
    process.env["NAT_FAKE_DIR"] = dir;
    const options = transportFor(dir);
    options.multiplex = false;
    const connection = new SshConnection(options, workspace(), targetFor("leaf1"));

    await connection.open();
    assert.equal(connection.controlPath, "", "no master is started");
    const result = await connection.exec("uptime", 10);
    assert.equal(result.output, "up 3 days\n");
    connection.close();
  });

  test("workspace disposal terminates an in-flight non-multiplexed ssh child", async () => {
    const dir = replies({ uptime: "up 3 days\n" });
    process.env["NAT_FAKE_DIR"] = dir;
    process.env["NAT_FAKE_HOLD_EXEC"] = "1";
    const options = transportFor(dir);
    options.multiplex = false;
    const ws = workspace();
    const connection = new SshConnection(options, ws, targetFor("leaf1"));

    const pending = connection.exec("uptime", 30);
    assert.equal(ws.childProcesses.count(), 1);
    ws.dispose();
    const result = await pending;
    assert.notEqual(result.code, 0);
    assert.equal(ws.childProcesses.count(), 0);
    delete process.env["NAT_FAKE_HOLD_EXEC"];
  });

  test("--no-multiplex surfaces an auth failure on the first command", async () => {
    const dir = replies({});
    process.env["NAT_FAKE_DIR"] = dir;
    process.env["NAT_FAKE_AUTH_FAIL"] = "1";
    const options = transportFor(dir);
    options.multiplex = false;
    const connection = new SshConnection(options, workspace(), targetFor("leaf1"));
    await connection.open();
    await assert.rejects(() => connection.exec("uptime", 10), /authentication failed/);
    delete process.env["NAT_FAKE_AUTH_FAIL"];
  });

  test("--no-multiplex also surfaces interactive authentication failures", async () => {
    const dir = replies({});
    process.env["NAT_FAKE_DIR"] = dir;
    process.env["NAT_FAKE_AUTH_FAIL"] = "1";
    const options = transportFor(dir);
    options.multiplex = false;
    const connection = new SshConnection(options, workspace(), targetFor("leaf1"));
    await connection.open();
    await assert.rejects(() => openShell(connection, 100), /authentication failed/);
    delete process.env["NAT_FAKE_AUTH_FAIL"];
  });
});
