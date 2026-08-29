import { strict as assert } from "node:assert";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { parseOutput } from "../src/drivers.ts";
import { parseJson, renderJson } from "../src/json.ts";
import { ParserContext } from "../src/models.ts";
import {
  ParserPackError,
  commandParser,
  commandParserTable,
  compileParserPack,
  loadParserPacks,
} from "../src/parser-packs.ts";

function pack(source: string) {
  return compileParserPack(parseJson(source), "(test)");
}

function run(table: ReturnType<typeof pack> | null, driver: string, command: string, raw: string): string {
  const parsed = parseOutput(driver, command, raw, new ParserContext("h1", command, driver), table);
  assert.ok(parsed !== null, "no parser matched");
  return renderJson(parsed);
}

describe("declarative parser packs", () => {
  test("extracts named fields with typed captures", () => {
    const table = pack(
      JSON.stringify({
        sonic: {
          "show version": {
            kind: "demo.version",
            fields: {
              version: { pattern: "Version:\\s*(\\S+)" },
              build: { pattern: "Build:\\s*(\\d+)", type: "number" },
              healthy: { pattern: "Healthy:\\s*(\\S+)", type: "boolean" },
            },
          },
        },
      }),
    );
    const raw = "Version: 4.1.0\nBuild: 42\nHealthy: yes\n";
    assert.equal(run(table, "sonic", "show version", raw), '{"kind":"demo.version","version":"4.1.0","build":42,"healthy":true}');
  });

  test("omits a field whose pattern does not match", () => {
    const table = pack(JSON.stringify({ linux: { x: { fields: { a: { pattern: "A=(\\d+)" } } } } }));
    assert.equal(run(table, "linux", "x", "B=1\n"), "{}");
  });

  test("builds rows, skipping the lines it is told to", () => {
    const table = pack(
      JSON.stringify({
        linux: {
          "show routes": {
            kind: "demo.routes",
            list: "routes",
            skip: ["^Codes:"],
            row: {
              pattern: "^(\\S+/\\d+)\\s+via\\s+(\\S+)$",
              fields: [{ name: "prefix" }, { name: "nextHop" }],
            },
            count: true,
          },
        },
      }),
    );
    const raw = "Codes: C - connected\n10.0.0.0/24 via 10.0.0.1\n10.1.0.0/24 via 10.0.0.2\nnoise\n";
    assert.equal(
      run(table, "linux", "show routes", raw),
      '{"kind":"demo.routes","routes":[{"prefix":"10.0.0.0/24","nextHop":"10.0.0.1"},{"prefix":"10.1.0.0/24","nextHop":"10.0.0.2"}],"count":2}',
    );
  });

  test("names capture groups automatically when no field list is given", () => {
    const table = pack(JSON.stringify({ linux: { x: { list: "rows", row: { pattern: "^(\\w+)=(\\w+)$" } } } }));
    assert.equal(run(table, "linux", "x", "a=1\n"), '{"rows":[{"group1":"a","group2":"1"}]}');
  });

  test("reuses the built-in table parser and key/value parser", () => {
    const table = pack(JSON.stringify({ linux: { "cols": { table: true }, "kv": { keyValue: true } } }));
    assert.equal(run(table, "linux", "cols", "A B\n1 2\n"), '{"columns":["a","b"],"rows":[{"a":"1","b":"2"}]}');
    assert.equal(run(table, "linux", "kv", "A: 1\n"), '{"fields":{"A":"1"},"lines":["A: 1"]}');
  });

  test("a pack rule wins over the built-in for the same driver and command", () => {
    const table = pack(JSON.stringify({ sonic: { "show version": { kind: "override" } } }));
    assert.equal(run(table, "sonic", "show version", "SONiC Software Version: 4.1.0\n"), '{"kind":"override"}');
  });

  test("command keys accept globs, matched after the exact key", () => {
    const table = pack(JSON.stringify({ linux: { "ip -br *": { kind: "brief" } } }));
    assert.equal(run(table, "linux", "ip -br addr", "eth0 UP\n"), '{"kind":"brief"}');
  });

  test("later --parsers sources win", () => {
    const dir = mkdtempSync(join(tmpdir(), "nat-pack-"));
    const first = join(dir, "a.json");
    const second = join(dir, "b.json");
    writeFileSync(first, JSON.stringify({ linux: { x: { kind: "first" }, y: { kind: "kept" } } }));
    writeFileSync(second, JSON.stringify({ linux: { x: { kind: "second" } } }));
    const table = loadParserPacks([first, second]);
    assert.equal(run(table, "linux", "x", ""), '{"kind":"second"}');
    assert.equal(run(table, "linux", "y", ""), '{"kind":"kept"}');
  });

  test("reports a malformed pack by path and rule", () => {
    assert.throws(() => pack(JSON.stringify({ linux: { x: { fields: { a: {} } } } })), ParserPackError);
    assert.throws(() => pack(JSON.stringify({ linux: { x: { fields: { a: {} } } } })), /field 'a' has no pattern/);
    assert.throws(() => pack(JSON.stringify({ linux: "nope" })), /expected an object of command rules/);
    assert.throws(() => pack(JSON.stringify({ linux: { x: { row: { pattern: "([" } } } })), /\.row:/);
    assert.throws(
      () => pack(JSON.stringify({ linux: { x: { fields: { a: { pattern: "(a)", flags: "g" } } } } })),
      /flags 'g' and 'y' are not supported/,
    );
    assert.throws(() => loadParserPacks(["/definitely/not/here.json"]), /parser pack not found/);
  });
});

describe("external parser programs", () => {
  test("feeds the command context in and reads JSON back", () => {
    const dir = mkdtempSync(join(tmpdir(), "nat-parsercmd-"));
    const program = join(dir, "parser.sh");
    // Echoes the request back, so the test also pins the payload's shape.
    writeFileSync(program, '#!/bin/sh\ncat\n');
    chmodSync(program, 0o700);
    const table = commandParserTable(program, []);
    const out = run(table, "linux", "uptime", "load 0.1\n");
    const parsed = JSON.parse(out);
    assert.equal(parsed.host, "h1");
    assert.equal(parsed.command, "uptime");
    assert.equal(parsed.driver, "linux");
    assert.equal(parsed.raw, "load 0.1\n");
  });

  test("a failing program surfaces as parseError, not a failed run", () => {
    const dir = mkdtempSync(join(tmpdir(), "nat-parsercmd-"));
    const program = join(dir, "bad.sh");
    writeFileSync(program, '#!/bin/sh\necho "nope" >&2\nexit 3\n');
    chmodSync(program, 0o700);
    const out = run(commandParserTable(program, []), "linux", "uptime", "x");
    assert.ok(out.includes("parseError"));
  });

  test("non-JSON output surfaces as parseError", () => {
    const dir = mkdtempSync(join(tmpdir(), "nat-parsercmd-"));
    const program = join(dir, "text.sh");
    writeFileSync(program, '#!/bin/sh\necho "not json"\n');
    chmodSync(program, 0o700);
    const out = run(commandParserTable(program, []), "linux", "uptime", "x");
    assert.ok(out.includes("invalid JSON"));
  });

  test("a parser program cannot stall the run indefinitely", () => {
    const dir = mkdtempSync(join(tmpdir(), "nat-parsercmd-"));
    const program = join(dir, "hang.sh");
    writeFileSync(program, "#!/bin/sh\nwhile :; do :; done\n");
    chmodSync(program, 0o700);
    const parse = commandParser(program, [], 50);
    const started = Date.now();
    const parsed = parse("raw", new ParserContext("leaf1", "show x", "sonic"));
    assert.ok(Date.now() - started < 2_000, "the parser timeout should be prompt");
    assert.ok(renderJson(parsed).includes("parser command failed"));
  });
});
