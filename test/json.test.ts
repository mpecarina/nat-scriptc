import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import {
  Json,
  jarr,
  jbool,
  jnull,
  jnum,
  jobj,
  jstr,
  parseJson,
  renderJson,
  renderJsonPretty,
} from "../src/json.ts";

describe("Json rendering", () => {
  test("renders scalars the way JSON.stringify does", () => {
    assert.equal(renderJson(jstr("a\nb\t\"c\"\\")), JSON.stringify('a\nb\t"c"\\'));
    assert.equal(renderJson(jnum(3)), "3");
    assert.equal(renderJson(jnum(1.5)), "1.5");
    assert.equal(renderJson(jbool(true)), "true");
    assert.equal(renderJson(jnull()), "null");
  });

  test("renders control characters and lone surrogates like JSON.stringify", () => {
    assert.equal(renderJson(jstr("")), JSON.stringify(""));
    assert.equal(renderJson(jstr("\ud800")), JSON.stringify("\ud800"));
    assert.equal(renderJson(jstr("😀")), JSON.stringify("😀"));
  });

  test("non-finite numbers render as null, like JSON.stringify", () => {
    assert.equal(renderJson(jnum(Number.POSITIVE_INFINITY)), "null");
    assert.equal(renderJson(jnum(Number.NaN)), "null");
  });

  test("keeps object members in insertion order", () => {
    const node = jobj().setStr("b", "1").setStr("a", "2");
    assert.equal(renderJson(node), '{"b":"1","a":"2"}');
  });

  test("set replaces in place rather than appending a duplicate", () => {
    const node = jobj().setStr("a", "1").setStr("b", "2").setStr("a", "3");
    assert.equal(renderJson(node), '{"a":"3","b":"2"}');
  });

  test("empty containers render compactly even when pretty-printing", () => {
    assert.equal(renderJsonPretty(jobj().set("a", jarr()).set("b", jobj()), 2), '{\n  "a": [],\n  "b": {}\n}');
  });

  test("pretty output matches JSON.stringify's shape", () => {
    const node = jobj().setStr("a", "x").set("c", jarr().push(jnum(1)).push(jstr("y")));
    const expected = JSON.stringify({ a: "x", c: [1, "y"] }, null, 2);
    assert.equal(renderJsonPretty(node, 2), expected);
  });

  test("optional setters omit absent values but keep explicit nulls", () => {
    const node = jobj();
    node.setOptStr("a", null);
    node.setOptNum("b", null);
    node.setOptBool("c", null);
    node.setStrOrNull("d", null);
    node.setOptStr("e", "kept");
    assert.equal(renderJson(node), '{"d":null,"e":"kept"}');
  });
});

describe("Json parsing", () => {
  test("round-trips every scalar kind", () => {
    const text = '{"s":"a\\nb","n":-2.5e2,"t":true,"f":false,"z":null,"a":[1,{"k":"v"}]}';
    const parsed = parseJson(text);
    assert.equal(renderJson(parsed), JSON.stringify(JSON.parse(text)));
  });

  test("decodes \\u escapes", () => {
    assert.equal(parseJson('"\\u0041\\u00e9"').s, "Aé");
  });

  test("reads nested members by path", () => {
    const root = parseJson('{"devices":[{"id":"a","port":22,"ok":true}]}');
    const devices = root.get("devices");
    assert.ok(devices !== null);
    const device: Json = devices.items[0];
    assert.equal(device.str("id", "?"), "a");
    assert.equal(device.num("port", 0), 22);
    assert.equal(device.bool("ok", false), true);
    assert.equal(device.str("missing", "fallback"), "fallback");
  });

  test("rejects trailing content", () => {
    assert.throws(() => parseJson("{} extra"), /trailing content/);
  });

  test("rejects a truncated object", () => {
    assert.throws(() => parseJson('{"a":'), /unexpected end of input/);
  });

  test("rejects missing values instead of silently turning them into zero", () => {
    assert.throws(() => parseJson('{"a":}'), /expected a JSON value/);
    assert.throws(() => parseJson("[,]"), /expected a JSON value/);
  });

  test("accepts only JSON's number grammar", () => {
    for (const invalid of ["+1", ".5", "01", "1.", "1e"]) {
      assert.throws(() => parseJson(invalid), Error, invalid);
    }
    for (const valid of ["0", "-0", "12", "0.5", "-2.5e+3", "1e400"]) {
      assert.equal(renderJson(parseJson(valid)), JSON.stringify(JSON.parse(valid)));
    }
  });

  test("rejects literal control characters inside strings", () => {
    assert.throws(() => parseJson('"line\nbreak"'), /unescaped control character/);
  });
});
