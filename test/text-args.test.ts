import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import {
  ArgError,
  booleanOption,
  parseArgs,
  repeatedOption,
  splitAtSeparator,
  stringOption,
  wantsHelp,
} from "../src/args.ts";
import {
  globToRegExp,
  indentLines,
  lastNonEmptyLine,
  normalizeSpace,
  parseIntPrefix,
  shellQuote,
  splitLines,
  trimBlankEdges,
} from "../src/text.ts";

describe("text helpers", () => {
  test("splits on every line ending device transcripts mix", () => {
    assert.deepEqual(splitLines("a\r\nb\rc\nd"), ["a", "b", "c", "d"]);
  });

  test("globToRegExp handles * and ? and escapes the rest", () => {
    assert.equal(globToRegExp("leaf*").test("leaf1"), true);
    assert.equal(globToRegExp("leaf*").test("spine1"), false);
    assert.equal(globToRegExp("a?c").test("abc"), true);
    assert.equal(globToRegExp("a.c").test("abc"), false);
    assert.equal(globToRegExp("a.c").test("a.c"), true);
  });

  test("parseIntPrefix follows parseInt, not Number", () => {
    assert.equal(parseIntPrefix("22x", 0), 22);
    assert.equal(parseIntPrefix(" -7 ", 0), -7);
    assert.equal(parseIntPrefix("x22", 9), 9);
    assert.equal(parseIntPrefix("", 9), 9);
  });

  test("shellQuote survives embedded single quotes", () => {
    assert.equal(shellQuote("it's"), "'it'\\''s'");
  });

  test("normalizeSpace collapses runs of whitespace", () => {
    assert.equal(normalizeSpace("  ls   -lh   / "), "ls -lh /");
  });

  test("trimBlankEdges keeps interior blank lines", () => {
    assert.deepEqual(trimBlankEdges(["", "a", "", "b", "", ""]), ["a", "", "b"]);
  });

  test("indentLines leaves blank lines unpadded", () => {
    assert.equal(indentLines("a\n\nb", 2), "  a\n\n  b");
  });

  test("lastNonEmptyLine finds the prompt at the end of a transcript", () => {
    assert.equal(lastNonEmptyLine("out\nleaf1# \n\n"), "leaf1#");
    assert.equal(lastNonEmptyLine("  \n"), null);
  });
});

describe("argument parsing", () => {
  const specs = [
    repeatedOption("command", "c"),
    stringOption("file", "f"),
    booleanOption("all", ""),
    booleanOption("quiet", "q"),
    booleanOption("verbose", "V"),
  ];

  test("reads long options with a space or an equals sign", () => {
    const parsed = parseArgs(["--file", "a.txt"], specs, true);
    assert.equal(parsed.str("file", ""), "a.txt");
    assert.equal(parseArgs(["--file=b.txt"], specs, true).str("file", ""), "b.txt");
  });

  test("accumulates a repeated option in order", () => {
    const parsed = parseArgs(["-c", "one", "--command", "two", "-c=three"], specs, true);
    assert.deepEqual(parsed.list("command"), ["one", "two", "three"]);
  });

  test("a non-repeated option keeps the last value", () => {
    assert.equal(parseArgs(["--file", "a", "--file", "b"], specs, true).str("file", ""), "b");
  });

  test("clusters short booleans", () => {
    const parsed = parseArgs(["-qV"], specs, true);
    assert.equal(parsed.bool("quiet"), true);
    assert.equal(parsed.bool("verbose"), true);
  });

  test("a clustered short option can take the following value", () => {
    const parsed = parseArgs(["-qc", "uptime"], specs, true);
    assert.equal(parsed.bool("quiet"), true);
    assert.deepEqual(parsed.list("command"), ["uptime"]);
  });

  test("collects positionals in order", () => {
    assert.deepEqual(parseArgs(["leaf1", "-q", "leaf2"], specs, true).positionals, ["leaf1", "leaf2"]);
  });

  test("names an unknown option", () => {
    assert.throws(() => parseArgs(["--nope"], specs, true), ArgError);
    assert.throws(() => parseArgs(["--nope"], specs, true), /unknown option: --nope/);
    assert.throws(() => parseArgs(["-z"], specs, true), /unknown option: -z/);
  });

  test("rejects a value-less string option and a valued boolean", () => {
    assert.throws(() => parseArgs(["--file"], specs, true), /requires a value/);
    assert.throws(() => parseArgs(["--all=1"], specs, true), /takes no value/);
  });

  test("int() falls back when the value is absent or unparsable", () => {
    const parsed = parseArgs(["--file", "x"], specs, true);
    assert.equal(parsed.int("missing", 5), 5);
    assert.equal(parsed.int("file", 5), 5);
    assert.equal(parseArgs(["--file", "7"], specs, true).int("file", 5), 7);
    assert.equal(parseArgs(["--file", "12seconds"], specs, true).int("file", 5), 12);
  });

  test("splitAtSeparator splits once, at the first bare --", () => {
    const split = splitAtSeparator(["leaf1", "--", "uptime", "--", "df -h"]);
    assert.deepEqual(split.head, ["leaf1"]);
    assert.deepEqual(split.tail, ["uptime", "--", "df -h"]);
  });

  test("wantsHelp sees both spellings", () => {
    assert.equal(wantsHelp(["run", "-h"]), true);
    assert.equal(wantsHelp(["run", "--help"]), true);
    assert.equal(wantsHelp(["run"]), false);
  });
});
