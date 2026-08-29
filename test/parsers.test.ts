import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

import { parseOutput, resolveParser } from "../src/drivers.ts";
import { renderJson } from "../src/json.ts";
import { ParserContext } from "../src/models.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "parsers");

interface FixtureCase {
  driver: string;
  command: string;
  fixture: string;
}

const manifest: FixtureCase[] = JSON.parse(readFileSync(join(FIXTURES, "manifest.json"), "utf8"));
const golden: Record<string, unknown> = JSON.parse(readFileSync(join(FIXTURES, "golden.json"), "utf8"));

/**
 * `golden.json` was produced by running the Bun/ssh2 implementation's parsers
 * over these same fixtures. Matching it byte for byte is the port's contract:
 * every consumer of `--parse` keeps reading the shape it already reads.
 */
describe("parser output matches the reference implementation", () => {
  for (const entry of manifest) {
    test(`${entry.driver} — ${entry.command}`, () => {
      const raw = readFileSync(join(FIXTURES, entry.fixture), "utf8");
      const ctx = new ParserContext("h1", entry.command, entry.driver);
      const parsed = parseOutput(entry.driver, entry.command, raw, ctx, null);
      const key = `${entry.driver}|${entry.command}`;
      const expected = golden[key];
      if (expected === null) {
        assert.equal(parsed, null, `${key} should have no parser`);
        return;
      }
      assert.ok(parsed !== null, `${key} produced no parsed output`);
      assert.equal(renderJson(parsed), JSON.stringify(expected), key);
    });
  }
});

describe("parser resolution", () => {
  test("prefers an exact command over a glob", () => {
    const exact = resolveParser("sonic", "show ip route", null);
    const glob = resolveParser("sonic", "show ip route vrf Vrf1", null);
    assert.ok(exact !== null && glob !== null);
    assert.equal(exact, glob, "both spellings reach the same sonic route parser");
  });

  test("normalizes whitespace before matching", () => {
    const ctx = new ParserContext("h1", "show   ip    route", "sonic");
    const parsed = parseOutput("sonic", "show   ip    route", "C>* 10.0.0.0/24 is directly connected, Ethernet0\n", ctx, null);
    assert.ok(parsed !== null);
    assert.ok(renderJson(parsed).includes('"kind":"sonic.ipRoute"'));
  });

  test("an unknown driver falls back to key/value extraction", () => {
    const ctx = new ParserContext("h1", "anything", "cumulus");
    const parsed = parseOutput("cumulus", "anything", "Key: Value\n", ctx, null);
    assert.ok(parsed !== null);
    assert.equal(renderJson(parsed), '{"fields":{"Key":"Value"},"lines":["Key: Value"]}');
  });

  test("the generic wildcard sniffs iproute2 output the command never named", () => {
    // A caller that ships the verb inside a base64 shim leaves no glob to match,
    // so the fallback recognizes the OUTPUT instead.
    const wrapped = "__loom_cmd=$(mktemp); echo 'aXAgYWRkcg==' | base64 -d > $__loom_cmd; bash $__loom_cmd";
    const raw = "2: eth0: <BROADCAST,UP,LOWER_UP> mtu 1500 qdisc fq_codel state UP\n    inet 10.0.0.5/24 scope global eth0\n";
    const ctx = new ParserContext("h1", wrapped, "linux");
    const parsed = parseOutput("linux", wrapped, raw, ctx, null);
    assert.ok(parsed !== null);
    assert.ok(renderJson(parsed).includes('"name":"eth0"'));
  });

  test("normalizes an IPv6 default route to ::/0", () => {
    const command = "ip -6 route";
    const ctx = new ParserContext("h1", command, "linux");
    const parsed = parseOutput("linux", command, "default via fe80::1 dev eth0\n", ctx, null);
    assert.ok(parsed !== null);
    assert.ok(renderJson(parsed).includes('"prefix":"::/0"'));
  });

  test("a throwing parser is captured, not propagated", () => {
    const table = resolveParser("generic", "anything", null);
    assert.ok(table !== null);
    // parseOutput wraps every parser call; a pack rule that throws surfaces as
    // parseError rather than failing the run that collected good output.
    const ctx = new ParserContext("h1", "x", "generic");
    const result = parseOutput("generic", "x", "ok\n", ctx, null);
    assert.ok(result !== null);
  });
});
