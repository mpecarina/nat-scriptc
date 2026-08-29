import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import {
  InventoryError,
  inventoryFromText,
  isHostPattern,
  loadJsonInventory,
  resolveHost,
  selectHosts,
  suggestAliases,
} from "../src/inventory.ts";

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
  test("resolves every field a host block sets", () => {
    const host = resolveHost(inventory().config, "leaf1");
    assert.equal(host.hostname, "10.0.0.1");
    assert.equal(host.user, "admin");
    assert.equal(host.port, 2222);
    assert.deepEqual(host.identityFiles, ["~/.ssh/id_lab"]);
    assert.equal(host.identitiesOnly, true);
    assert.equal(host.proxyJump, "bastion");
    assert.equal(host.targetOs, "sonic");
  });

  test("IdentityFile none disables keys instead of naming a file", () => {
    const inv = inventoryFromText("Host leaf1\n  IdentityFile none\n", "test");
    assert.deepEqual(resolveHost(inv.config, "leaf1").identityFiles, []);
  });

  test("defaults an unlisted host to itself on port 22", () => {
    const host = resolveHost(inventory().config, "10.9.9.9");
    assert.equal(host.hostname, "10.9.9.9");
    assert.equal(host.port, 22);
    assert.equal(host.user, "");
    assert.equal(host.targetOs, "");
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
    assert.equal(inv.source, "vmlab");

    const leaf = resolveHost(inv.config, "leaf1");
    assert.equal(leaf.hostname, "10.0.0.1");
    assert.equal(leaf.user, "admin");
    assert.equal(leaf.port, 2222);
    assert.equal(leaf.targetOs, "sonic");
    assert.equal(leaf.identitiesOnly, true);
    assert.ok(inv.syntheticText.includes("PubkeyAuthentication no"));
    assert.equal(inv.passwordByHost.get("leaf1"), "s3cret");

    const web = resolveHost(inv.config, "web1");
    assert.equal(web.hostname, "10.0.1.1");
    assert.deepEqual(web.identityFiles, ["~/.ssh/id_lab"]);
  });

  test("does not coerce a non-string inventory password", () => {
    const path = writeInventory(JSON.stringify({ devices: [{ id: "leaf1", mgmtIp: "10.0.0.1", password: 1234 }] }));
    const inv = loadJsonInventory(path);
    assert.equal(inv.passwordByHost.has("leaf1"), false);
    assert.equal(resolveHost(inv.config, "leaf1").identitiesOnly, false);
  });

  test("rejects duplicate aliases instead of mixing first-host and last-password values", () => {
    const path = writeInventory(JSON.stringify({
      devices: [
        { id: "leaf1", mgmtIp: "10.0.0.1", password: "first" },
        { id: "leaf1", mgmtIp: "10.0.0.2", password: "second" },
      ],
    }));
    const inventory = loadJsonInventory(path);
    assert.equal(resolveHost(inventory.config, "leaf1").hostname, "10.0.0.1");
    assert.equal(inventory.passwordByHost.get("leaf1"), "first");
    assert.equal(inventory.deviceCount, 1);
    assert.equal(inventory.skipped.length, 1);
    assert.equal(inventory.skipped[0].reason, "duplicate alias");
  });

  test("the generated config uses the comment driver form ssh accepts", () => {
    const path = writeInventory(JSON.stringify({ devices: [{ id: "leaf1", mgmtIp: "10.0.0.1", driver: "sonic" }] }));
    const inv = loadJsonInventory(path);
    assert.ok(inv.syntheticText.includes("#nat-driver sonic"));
    assert.equal(inv.config.hasBareNatKeywords, false);
  });

  test("skips devices with no usable address or alias", () => {
    const path = writeInventory(
      JSON.stringify({
        devices: [
          { id: "no-ip" },
          { id: "badip", mgmtIp: "10.0.0.1 ; rm -rf /" },
          { mgmtIp: "10.0.0.2", name: "has space" },
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
    assert.equal(resolveHost(inv.config, "leaf1").user, "");
  });

  test("rejects a file that is not the inventory schema", () => {
    const path = writeInventory(JSON.stringify({ hosts: [] }));
    assert.throws(() => loadJsonInventory(path), InventoryError);
  });

  test("reports malformed JSON as an inventory error", () => {
    const path = writeInventory("{ not json");
    assert.throws(() => loadJsonInventory(path), /not valid JSON/);
  });
});
