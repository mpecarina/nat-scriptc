import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import {
  conditionMatches,
  parseCommandSpec,
  readCommandText,
  skipReason,
} from "../src/command-files.ts";
import { OP_CONTAINS, OP_EQUALS, OP_NOT_CONTAINS, OP_NOT_EQUALS } from "../src/models.ts";

describe("parseCommandSpec", () => {
  test("parses a plain command", () => {
    const spec = parseCommandSpec("show version");
    assert.equal(spec.text, "show version");
    assert.equal(spec.hasCondition(), false);
    assert.equal(spec.source, "show version");
  });

  test("trims surrounding whitespace", () => {
    assert.equal(parseCommandSpec("  uptime  ").text, "uptime");
  });

  test("parses every conditional operator", () => {
    const cases: string[][] = [
      ["when contains:Active :: write memory", OP_CONTAINS, "Active", "write memory"],
      ["when not-contains:down :: no shutdown", OP_NOT_CONTAINS, "down", "no shutdown"],
      ["when equals:up :: report", OP_EQUALS, "up", "report"],
      ["when not-equals:up :: shutdown", OP_NOT_EQUALS, "up", "shutdown"],
    ];
    for (const entry of cases) {
      const spec = parseCommandSpec(entry[0]);
      assert.equal(spec.conditionOperator, entry[1]);
      assert.equal(spec.conditionValue, entry[2]);
      assert.equal(spec.text, entry[3]);
      assert.equal(spec.source, entry[0]);
    }
  });

  test("the operator prefix is matched case-insensitively", () => {
    const spec = parseCommandSpec("WHEN CONTAINS:Active :: write memory");
    assert.equal(spec.conditionOperator, OP_CONTAINS);
    assert.equal(spec.conditionValue, "Active");
  });

  test("rejects an empty command", () => {
    assert.throws(() => parseCommandSpec("   "), /cannot be empty/);
  });

  test("rejects a conditional missing the :: separator or the command", () => {
    assert.throws(() => parseCommandSpec("when contains:Active write memory"), /when <operator>/);
    assert.throws(() => parseCommandSpec("when contains:Active :: "), /when <operator>/);
  });
});

describe("readCommandText", () => {
  test("skips blank lines and # comments", () => {
    const specs = readCommandText(["# header", "", "show version", "  ", "uptime"].join("\n"));
    assert.deepEqual(
      specs.map((s) => s.text),
      ["show version", "uptime"],
    );
  });
});

describe("conditionMatches", () => {
  test("evaluates each operator against the previous output", () => {
    assert.equal(conditionMatches(parseCommandSpec("when contains:Act :: x"), "Active"), true);
    assert.equal(conditionMatches(parseCommandSpec("when contains:Act :: x"), "Down"), false);
    assert.equal(conditionMatches(parseCommandSpec("when not-contains:Act :: x"), "Down"), true);
    assert.equal(conditionMatches(parseCommandSpec("when equals:up :: x"), "  up  "), true);
    assert.equal(conditionMatches(parseCommandSpec("when not-equals:up :: x"), "down"), true);
  });

  test("an unconditional command always runs", () => {
    assert.equal(conditionMatches(parseCommandSpec("uptime"), ""), true);
  });

  test("the skip message names the operator and the value", () => {
    assert.equal(
      skipReason(parseCommandSpec("when contains:Active :: write memory")),
      "skipped: condition not met (contains 'Active')",
    );
  });
});
