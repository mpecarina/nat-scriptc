import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import {
  Inventory,
  InventoryError,
  isHostPattern,
  loadJsonInventory,
  resolveHost,
  selectHosts,
  suggestAliases,
} from "../src/inventory.ts";
import { computeHost, keywordValue, parseSshConfigText } from "../src/sshconfig.ts";

function inventoryFromText(text: string, label: string): Inventory {
  return new Inventory(parseSshConfigText(text, ""), label);
}

/** A generated-config setting as ssh will read it. */
function setting(inv: Inventory, alias: string, key: string): string {
  return keywordValue(computeHost(inv.config, alias), key, "");
}

const CONFIG = [
  "Host *",
  "  ServerAliveInterval 30",
  "",
  "Host leaf1",
  "  HostName 10.0.0.1",
  "  User admin",
  "  Port 2222",
  "  IdentityFile ~/.ssh/id_lab",
  "  IdentitiesOnly yes",
  "  ProxyJump bastion",
  "  #nat-driver sonic",
  "",
  "Host leaf2",
  "  HostName 10.0.0.2",
  "",
  "Host web1",
  "  HostName 10.0.1.1",
].join("\n");

function inventory() {
  return inventoryFromText(CONFIG, "(test)");
}

describe("resolveHost", () => {
  test("reads the alias and its #nat-driver", () => {
    const host = resolveHost(inventory().config, "leaf1");
    assert.equal(host.alias, "leaf1");
    assert.equal(host.targetOs, "sonic");
  });

  test("a bare nat-driver keyword is not a driver", () => {
    const inv = inventoryFromText("Host leaf1\n  nat-driver sonic\n", "test");
    assert.equal(resolveHost(inv.config, "leaf1").targetOs, "");
  });

  test("an unlisted host has no driver", () => {
    assert.equal(resolveHost(inventory().config, "10.9.9.9").targetOs, "");
  });
});

describe("selectHosts", () => {
  test("passes literal tokens through, including unknown ones", () => {
    const selection = selectHosts(inventory().config, ["leaf1", "10.9.9.9"], false);
    assert.deepEqual(selection.hosts, ["leaf1", "10.9.9.9"]);
    assert.deepEqual(selection.unmatched, []);
  });

  test("expands globs against the known aliases", () => {
    const selection = selectHosts(inventory().config, ["leaf*"], false);
    assert.deepEqual(selection.hosts, ["leaf1", "leaf2"]);
  });

  test("reports a glob that matches nothing", () => {
    const selection = selectHosts(inventory().config, ["spine*"], false);
    assert.deepEqual(selection.hosts, []);
    assert.deepEqual(selection.unmatched, ["spine*"]);
  });

  test("--all expands to every alias and de-duplicates", () => {
    const selection = selectHosts(inventory().config, ["leaf1"], true);
    assert.deepEqual(selection.hosts, ["leaf1", "leaf2", "web1"]);
  });

  test("--all on an empty config is reported, not silently empty", () => {
    const selection = selectHosts(inventoryFromText("", "(test)").config, [], true);
    assert.deepEqual(selection.unmatched, ["--all"]);
  });

  test("isHostPattern only fires on glob characters", () => {
    assert.equal(isHostPattern("leaf*"), true);
    assert.equal(isHostPattern("leaf?"), true);
    assert.equal(isHostPattern("leaf1"), false);
  });
});

describe("suggestAliases", () => {
  test("suggests a near miss", () => {
    assert.deepEqual(suggestAliases(inventory().config, "leaf3"), ["leaf1", "leaf2"]);
  });

  test("stays silent for a known alias", () => {
    assert.deepEqual(suggestAliases(inventory().config, "leaf1"), []);
  });

  test("stays silent for an unrelated IP", () => {
    assert.deepEqual(suggestAliases(inventory().config, "192.168.4.7"), []);
  });
});

describe("loadJsonInventory", () => {
  function writeInventory(body: string): string {
    const dir = mkdtempSync(join(tmpdir(), "nat-inv-"));
    const path = join(dir, "inventory.json");
    writeFileSync(path, body);
    return path;
  }

  test("translates devices into a synthetic ssh config", () => {
    const path = writeInventory(
      JSON.stringify({
        source: "vmlab",
        devices: [
          { id: "leaf1", mgmtIp: "10.0.0.1", sshUser: "admin", sshPort: 2222, driver: "sonic", password: "s3cret" },
          { id: "web1", mgmtIps: ["10.0.1.1"], sshIdentityFile: "~/.ssh/id_lab" },
        ],
      }),
    );
    const inv = loadJsonInventory(path);
    assert.equal(inv.deviceCount, 2);

    assert.equal(setting(inv, "leaf1", "hostname"), "10.0.0.1");
    assert.equal(setting(inv, "leaf1", "user"), "admin");
    assert.equal(setting(inv, "leaf1", "port"), "2222");
    assert.equal(resolveHost(inv.config, "leaf1").targetOs, "sonic");
    assert.equal(setting(inv, "leaf1", "identitiesonly"), "yes");
    assert.equal(setting(inv, "leaf1", "pubkeyauthentication"), "no");
    assert.equal(inv.passwordByHost.get("leaf1"), "s3cret");

    assert.equal(setting(inv, "web1", "hostname"), "10.0.1.1");
    assert.equal(setting(inv, "web1", "identityfile"), "~/.ssh/id_lab");
  });

  test("does not coerce a non-string inventory password", () => {
    const path = writeInventory(JSON.stringify({ devices: [{ id: "leaf1", mgmtIp: "10.0.0.1", password: 1234 }] }));
    const inv = loadJsonInventory(path);
    assert.equal(inv.passwordByHost.has("leaf1"), false);
    assert.equal(setting(inv, "leaf1", "identitiesonly"), "");
  });

  test("rejects duplicate aliases instead of mixing first-host and last-password values", () => {
    const path = writeInventory(JSON.stringify({
      devices: [
        { id: "leaf1", mgmtIp: "10.0.0.1", password: "first" },
        { id: "leaf1", mgmtIp: "10.0.0.2", password: "second" },
      ],
    }));
    const inventory = loadJsonInventory(path);
    assert.equal(setting(inventory, "leaf1", "hostname"), "10.0.0.1");
    assert.equal(inventory.passwordByHost.get("leaf1"), "first");
    assert.equal(inventory.deviceCount, 1);
    assert.equal(inventory.skipped.length, 1);
    assert.equal(inventory.skipped[0].reason, "duplicate alias");
  });

  test("the generated config uses the comment driver form ssh accepts", () => {
    const path = writeInventory(JSON.stringify({ devices: [{ id: "leaf1", mgmtIp: "10.0.0.1", driver: "sonic" }] }));
    const inv = loadJsonInventory(path);
    assert.ok(inv.syntheticText.includes("#nat-driver sonic"));
    assert.equal(resolveHost(inv.config, "leaf1").targetOs, "sonic");
  });

  test("skips devices with no usable address or alias", () => {
    const path = writeInventory(
      JSON.stringify({
        devices: [
          { id: "no-ip" },
          { id: "badip", mgmtIp: "10.0.0.1 ; rm -rf /" },
          { mgmtIp: "10.0.0.2", id: "has space" },
          { id: "ok", mgmtIp: "10.0.0.3" },
        ],
      }),
    );
    const inv = loadJsonInventory(path);
    assert.equal(inv.deviceCount, 1);
    assert.equal(inv.skipped.length, 3);
    assert.ok(inv.skipped[0].reason.includes("no management IP"));
    assert.ok(inv.skipped[1].reason.includes("invalid management IP"));
  });

  test("refuses config injection through inventory values", () => {
    const path = writeInventory(
      JSON.stringify({ devices: [{ id: "leaf1", mgmtIp: "10.0.0.1", sshUser: "root\n    ProxyCommand evil" }] }),
    );
    const inv = loadJsonInventory(path);
    assert.ok(!inv.syntheticText.includes("ProxyCommand"));
    assert.equal(setting(inv, "leaf1", "user"), "");
  });

  test("rejects a file that is not the inventory schema", () => {
    assert.throws(() => loadJsonInventory(writeInventory(JSON.stringify({ hosts: [] }))), InventoryError);
    assert.throws(() => loadJsonInventory(writeInventory(JSON.stringify([]))), InventoryError);
  });

  test("reports malformed JSON as an inventory error", () => {
    const path = writeInventory("{ not json");
    assert.throws(() => loadJsonInventory(path), /not valid JSON/);
  });
});
