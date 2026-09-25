import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import {
  DRIVER_KEY,
  computeHost,
  keywordValue,
  listHostAliases,
  parseSshConfigFile,
  parseSshConfigText,
} from "../src/sshconfig.ts";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "nat-sshcfg-"));
}

describe("ssh config parsing", () => {
  test("lists literal host aliases and skips wildcards", () => {
    const config = parseSshConfigText(
      ["Host *", "  User root", "Host leaf1 leaf2", "  HostName 10.0.0.1", "Host !bad web*"].join("\n"),
      "",
    );
    assert.deepEqual(listHostAliases(config), ["leaf1", "leaf2"]);
  });

  test("resolves keywords with OpenSSH's first-value-wins rule", () => {
    const config = parseSshConfigText(
      ["Host leaf1", "  User admin", "  Port 2222", "Host *", "  User root", "  Port 22"].join("\n"),
      "",
    );
    const resolved = computeHost(config, "leaf1");
    assert.equal(keywordValue(resolved, "user", ""), "admin");
    assert.equal(keywordValue(resolved, "port", ""), "2222");
  });

  test("accepts Key=Value, quoted values and inline comments", () => {
    const config = parseSshConfigText(
      [
        "Host leaf1 # lab switch",
        '  HostName="10.0.0.1" # management address',
        '  User = "admin user" # quoted whitespace',
        "  #nat-driver sonic # nat metadata",
      ].join("\n"),
      "",
    );
    const resolved = computeHost(config, "leaf1");
    assert.equal(keywordValue(resolved, "hostname", ""), "10.0.0.1");
    assert.equal(keywordValue(resolved, "user", ""), "admin user");
    assert.equal(keywordValue(resolved, DRIVER_KEY, ""), "sonic");
  });

  test("host patterns honour globs and negation", () => {
    const config = parseSshConfigText(["Host leaf* !leaf9", "  User admin"].join("\n"), "");
    assert.equal(keywordValue(computeHost(config, "leaf1"), "user", ""), "admin");
    assert.equal(keywordValue(computeHost(config, "leaf9"), "user", "(none)"), "(none)");
  });

  test("Match host applies; a Match nat cannot evaluate is skipped", () => {
    const config = parseSshConfigText(
      ["Match host leaf1", "  User matched", "Match exec true", "  User guessed"].join("\n"),
      "",
    );
    const resolved = computeHost(config, "leaf1");
    assert.equal(keywordValue(resolved, "user", ""), "matched");
  });

  test("distinguishes Match host from originalhost and reads comma pattern-lists", () => {
    const config = parseSshConfigText(
      [
        "Host leaf1",
        "  HostName leaf1.example",
        "Match host leaf1",
        "  User wrong",
        "Match host LEAF1.EXAMPLE,other originalhost LEAF1",
        "  User matched",
        "  Port 2222",
      ].join("\n"),
      "",
    );
    const resolved = computeHost(config, "leaf1");
    assert.equal(keywordValue(resolved, "user", ""), "matched");
    assert.equal(keywordValue(resolved, "port", ""), "2222");
  });

  test("reads the driver from a comment so ssh still accepts the file", () => {
    const config = parseSshConfigText(["Host leaf1", "  HostName 10.0.0.1", "  #nat-driver sonic"].join("\n"), "");
    assert.equal(keywordValue(computeHost(config, "leaf1"), DRIVER_KEY, ""), "sonic");
  });

  test("only the #nat-driver spelling is a driver", () => {
    const config = parseSshConfigText(["Host leaf1", "  #Driver ios", "  # nat-driver eos", "  nat-driver nxos"].join("\n"), "");
    assert.equal(keywordValue(computeHost(config, "leaf1"), DRIVER_KEY, ""), "");
  });

  test("Include is inlined at its position, with globs", () => {
    const dir = scratch();
    mkdirSync(join(dir, "conf.d"), { recursive: true });
    writeFileSync(join(dir, "conf.d", "10-leaf.conf"), "Host leaf1\n  HostName 10.0.0.1\n");
    writeFileSync(join(dir, "conf.d", "20-web.conf"), "Host web1\n  HostName 10.0.1.1\n");
    writeFileSync(
      join(dir, "config"),
      [`Include ${join(dir, "conf.d", "*.conf")}`, "Host spine1", "  HostName 10.0.2.1"].join("\n"),
    );

    const config = parseSshConfigFile(join(dir, "config"));
    assert.deepEqual(listHostAliases(config), ["leaf1", "web1", "spine1"]);
    assert.equal(keywordValue(computeHost(config, "web1"), "hostname", ""), "10.0.1.1");
    assert.equal(keywordValue(computeHost(config, "spine1"), "hostname", ""), "10.0.2.1");
  });

  test("Include accepts a quoted path containing spaces", () => {
    const dir = scratch();
    const includeDir = join(dir, "config fragments");
    mkdirSync(includeDir, { recursive: true });
    const included = join(includeDir, "leaf.conf");
    writeFileSync(included, "Host quoted-leaf\n  User quoted\n");
    writeFileSync(join(dir, "config"), `Include "${included}"\n`);
    const config = parseSshConfigFile(join(dir, "config"));
    assert.deepEqual(listHostAliases(config), ["quoted-leaf"]);
    assert.equal(keywordValue(computeHost(config, "quoted-leaf"), "user", ""), "quoted");
  });

  test("an earlier block wins over a later included one", () => {
    const dir = scratch();
    writeFileSync(join(dir, "extra"), "Host leaf1\n  User included\n");
    writeFileSync(join(dir, "config"), ["Host leaf1", "  User outer", `Include ${join(dir, "extra")}`].join("\n"));
    const config = parseSshConfigFile(join(dir, "config"));
    assert.equal(keywordValue(computeHost(config, "leaf1"), "user", ""), "outer");
  });

  test("the same Include is processed each time under its active Host block", () => {
    const dir = scratch();
    const extra = join(dir, "identity.conf");
    writeFileSync(extra, "  IdentityFile ~/.ssh/id_shared\n");
    writeFileSync(
      join(dir, "config"),
      ["Host leaf1", `Include ${extra}`, "Host leaf2", `Include ${extra}`].join("\n"),
    );
    const config = parseSshConfigFile(join(dir, "config"));
    assert.equal(keywordValue(computeHost(config, "leaf1"), "identityfile", ""), "~/.ssh/id_shared");
    assert.equal(keywordValue(computeHost(config, "leaf2"), "identityfile", ""), "~/.ssh/id_shared");
  });
});
