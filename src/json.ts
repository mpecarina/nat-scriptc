/**
 * src/json.ts — a JSON value tree.
 *
 * A statically compiled binary has no JavaScript engine, so there is no `any`
 * and no reflective `JSON.stringify` over arbitrary objects. Parsed command
 * output is inherently open-shaped (every driver/command pair returns its own
 * structure), so nat models it explicitly: a `Json` node is a tagged tree that
 * every parser builds and one serializer renders.
 *
 * The tree is also the reader for open-shaped INPUT — vmlab JSON inventories
 * and declarative parser packs — where a checked `JSON.parse(...) as T` cast
 * would reject a file that merely carries an unexpected extra field.
 */

export class JsonError extends Error {}

export const JSON_NULL = "null";
export const JSON_BOOL = "bool";
export const JSON_NUM = "num";
export const JSON_STR = "str";
export const JSON_ARR = "arr";
export const JSON_OBJ = "obj";

/**
 * One JSON value. `kind` selects which payload is live; the unused fields keep
 * their zero values. Objects hold parallel `keys`/`vals` arrays so insertion
 * order — which is what the JSON envelope's readers see — is preserved exactly.
 */
export class Json {
  kind: string;
  b: boolean;
  n: number;
  s: string;
  items: Json[];
  keys: string[];
  vals: Json[];

  constructor(kind: string) {
    this.kind = kind;
    this.b = false;
    this.n = 0;
    this.s = "";
    this.items = [];
    this.keys = [];
    this.vals = [];
  }

  /** Set (or replace) an object member. Returns `this` so calls chain. */
  set(key: string, value: Json): Json {
    for (let i = 0; i < this.keys.length; i += 1) {
      if (this.keys[i] === key) {
        this.vals[i] = value;
        return this;
      }
    }
    this.keys.push(key);
    this.vals.push(value);
    return this;
  }

  setStr(key: string, value: string): Json {
    return this.set(key, jstr(value));
  }

  setNum(key: string, value: number): Json {
    return this.set(key, jnum(value));
  }

  setBool(key: string, value: boolean): Json {
    return this.set(key, jbool(value));
  }

  /**
   * Set a member only when the value is present. The Bun/JS original spelled
   * this `...(v ? { k: v } : {})`; an absent optional field must stay absent so
   * the JSON envelope keeps its documented shape.
   */
  setOptStr(key: string, value: string | null): Json {
    if (value === null || value === "") return this;
    return this.set(key, jstr(value));
  }

  setOptNum(key: string, value: number | null): Json {
    if (value === null) return this;
    return this.set(key, jnum(value));
  }

  setOptBool(key: string, value: boolean | null): Json {
    if (value === null) return this;
    return this.set(key, jbool(value));
  }

  /** Set a member to `null` when the value is absent (an explicit JSON null). */
  setStrOrNull(key: string, value: string | null): Json {
    return this.set(key, value === null ? jnull() : jstr(value));
  }

  setNumOrNull(key: string, value: number | null): Json {
    return this.set(key, value === null ? jnull() : jnum(value));
  }

  push(value: Json): Json {
    this.items.push(value);
    return this;
  }

  pushStr(value: string): Json {
    this.items.push(jstr(value));
    return this;
  }

  has(key: string): boolean {
    for (const k of this.keys) {
      if (k === key) return true;
    }
    return false;
  }

  /** Object member lookup; `null` when absent (or when this is not an object). */
  get(key: string): Json | null {
    for (let i = 0; i < this.keys.length; i += 1) {
      if (this.keys[i] === key) return this.vals[i];
    }
    return null;
  }

  /** The first present member among `names`, or `null`. */
  getAny(names: string[]): Json | null {
    for (const name of names) {
      const found = this.get(name);
      if (found !== null) return found;
    }
    return null;
  }

  /** Member as a string, or `fallback`. Numbers and booleans stringify. */
  str(key: string, fallback: string): string {
    const v = this.get(key);
    if (v === null) return fallback;
    return jsonAsString(v, fallback);
  }

  /** Member as a number, or `fallback`. Numeric strings convert. */
  num(key: string, fallback: number): number {
    const v = this.get(key);
    if (v === null) return fallback;
    return jsonAsNumber(v, fallback);
  }

  bool(key: string, fallback: boolean): boolean {
    const v = this.get(key);
    if (v === null) return fallback;
    if (v.kind === JSON_BOOL) return v.b;
    if (v.kind === JSON_STR) return v.s === "true" || v.s === "yes" || v.s === "1";
    if (v.kind === JSON_NUM) return v.n !== 0;
    return fallback;
  }

  isNull(): boolean {
    return this.kind === JSON_NULL;
  }
}

export function jnull(): Json {
  return new Json(JSON_NULL);
}

export function jbool(value: boolean): Json {
  const j = new Json(JSON_BOOL);
  j.b = value;
  return j;
}

export function jnum(value: number): Json {
  const j = new Json(JSON_NUM);
  j.n = value;
  return j;
}

export function jstr(value: string): Json {
  const j = new Json(JSON_STR);
  j.s = value;
  return j;
}

export function jarr(): Json {
  return new Json(JSON_ARR);
}

export function jobj(): Json {
  return new Json(JSON_OBJ);
}

/** An array node holding every string in `values`, in order. */
export function jstrArray(values: string[]): Json {
  const a = jarr();
  for (const v of values) a.items.push(jstr(v));
  return a;
}

export function jsonAsString(value: Json, fallback: string): string {
  if (value.kind === JSON_STR) return value.s;
  if (value.kind === JSON_NUM) return renderNumber(value.n);
  if (value.kind === JSON_BOOL) return value.b ? "true" : "false";
  return fallback;
}

export function jsonAsNumber(value: Json, fallback: number): number {
  if (value.kind === JSON_NUM) return value.n;
  if (value.kind === JSON_STR) {
    const n = Number(value.s.trim());
    return Number.isFinite(n) ? n : fallback;
  }
  if (value.kind === JSON_BOOL) return value.b ? 1 : 0;
  return fallback;
}

/* ------------------------------- rendering -------------------------------- */

const HEX = "0123456789abcdef";

function escapeString(value: string): string {
  let out = '"';
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    const ch = value.charAt(i);
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (code === 10) out += "\\n";
    else if (code === 13) out += "\\r";
    else if (code === 9) out += "\\t";
    else if (code === 8) out += "\\b";
    else if (code === 12) out += "\\f";
    else if (code < 32) {
      out += "\\u00" + HEX.charAt((code >> 4) & 15) + HEX.charAt(code & 15);
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += ch + value.charAt(i + 1);
        i += 1;
      } else {
        out += "\\u" +
          HEX.charAt((code >> 12) & 15) + HEX.charAt((code >> 8) & 15) +
          HEX.charAt((code >> 4) & 15) + HEX.charAt(code & 15);
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      out += "\\u" +
        HEX.charAt((code >> 12) & 15) + HEX.charAt((code >> 8) & 15) +
        HEX.charAt((code >> 4) & 15) + HEX.charAt(code & 15);
    } else out += ch;
  }
  return out + '"';
}

/** JSON's number grammar has no Infinity or NaN; both render as `null`. */
function renderNumber(value: number): string {
  if (!Number.isFinite(value)) return "null";
  if (Number.isInteger(value) && Math.abs(value) < 1e21) return `${value}`;
  return `${value}`;
}

function renderInto(node: Json, indent: number, depth: number, out: string[]): void {
  if (node.kind === JSON_NULL) {
    out.push("null");
    return;
  }
  if (node.kind === JSON_BOOL) {
    out.push(node.b ? "true" : "false");
    return;
  }
  if (node.kind === JSON_NUM) {
    out.push(renderNumber(node.n));
    return;
  }
  if (node.kind === JSON_STR) {
    out.push(escapeString(node.s));
    return;
  }

  const pretty = indent > 0;
  const pad = pretty ? "\n" + " ".repeat(indent * (depth + 1)) : "";
  const closePad = pretty ? "\n" + " ".repeat(indent * depth) : "";

  if (node.kind === JSON_ARR) {
    if (node.items.length === 0) {
      out.push("[]");
      return;
    }
    out.push("[");
    for (let i = 0; i < node.items.length; i += 1) {
      if (i > 0) out.push(",");
      out.push(pad);
      renderInto(node.items[i], indent, depth + 1, out);
    }
    out.push(closePad);
    out.push("]");
    return;
  }

  if (node.keys.length === 0) {
    out.push("{}");
    return;
  }
  out.push("{");
  for (let i = 0; i < node.keys.length; i += 1) {
    if (i > 0) out.push(",");
    out.push(pad);
    out.push(escapeString(node.keys[i]));
    out.push(pretty ? ": " : ":");
    renderInto(node.vals[i], indent, depth + 1, out);
  }
  out.push(closePad);
  out.push("}");
}

/** Serialize compactly (no whitespace) — the `--json` one-line form. */
export function renderJson(node: Json): string {
  const out: string[] = [];
  renderInto(node, 0, 0, out);
  return out.join("");
}

/** Serialize with `indent` spaces per level — the human-readable form. */
export function renderJsonPretty(node: Json, indent: number): string {
  const out: string[] = [];
  renderInto(node, indent, 0, out);
  return out.join("");
}

/* -------------------------------- parsing --------------------------------- */

class JsonReader {
  text: string;
  pos: number;

  constructor(text: string) {
    this.text = text;
    this.pos = 0;
  }

  fail(message: string): void {
    throw new JsonError(`${message} at position ${this.pos}`);
  }

  atEnd(): boolean {
    return this.pos >= this.text.length;
  }

  peek(): string {
    return this.pos < this.text.length ? this.text.charAt(this.pos) : "";
  }

  skipWhitespace(): void {
    while (this.pos < this.text.length) {
      const c = this.text.charCodeAt(this.pos);
      if (c === 32 || c === 9 || c === 10 || c === 13) this.pos += 1;
      else break;
    }
  }

  expect(ch: string): void {
    if (this.peek() !== ch) this.fail(`expected '${ch}'`);
    this.pos += 1;
  }

  literal(word: string): boolean {
    if (this.text.slice(this.pos, this.pos + word.length) === word) {
      this.pos += word.length;
      return true;
    }
    return false;
  }

  readString(): string {
    this.expect('"');
    let out = "";
    while (true) {
      if (this.atEnd()) {
        this.fail("unterminated string");
        return out;
      }
      const ch = this.text.charAt(this.pos);
      this.pos += 1;
      if (ch === '"') return out;
      if (ch !== "\\") {
        // JSON strings may not contain literal control characters. Accepting
        // them made malformed inventories diverge from JSON.parse and, worse,
        // let a missing escape quietly change the rest of a parser pack.
        if (ch.charCodeAt(0) < 32) {
          this.fail("unescaped control character in string");
          return out;
        }
        out += ch;
        continue;
      }
      if (this.atEnd()) {
        this.fail("unterminated escape");
        return out;
      }
      const esc = this.text.charAt(this.pos);
      this.pos += 1;
      if (esc === '"') out += '"';
      else if (esc === "\\") out += "\\";
      else if (esc === "/") out += "/";
      else if (esc === "n") out += "\n";
      else if (esc === "r") out += "\r";
      else if (esc === "t") out += "\t";
      else if (esc === "b") out += "\b";
      else if (esc === "f") out += "\f";
      else if (esc === "u") {
        const hex = this.text.slice(this.pos, this.pos + 4);
        if (hex.length < 4) {
          this.fail("truncated \\u escape");
          return out;
        }
        const code = Number("0x" + hex);
        if (!Number.isFinite(code)) {
          this.fail("invalid \\u escape");
          return out;
        }
        out += String.fromCharCode(code);
        this.pos += 4;
      } else {
        this.fail(`invalid escape '\\${esc}'`);
        return out;
      }
    }
    // Unreachable in TypeScript, but keeping an explicit return gives the C
    // backend a total control-flow shape as well. Without it, clang correctly
    // warns that the generated non-void function can fall off its end because
    // the backend does not preserve TypeScript's `while (true)` reachability
    // fact through every nested escape branch.
    return out;
  }

  readNumber(): number {
    const start = this.pos;
    if (this.peek() === "-") this.pos += 1;

    // Integer part: exactly 0, or a non-zero digit followed by digits. This
    // rejects JS-number spellings JSON does not permit (+1, .5, 01, 1.).
    if (this.peek() === "0") {
      this.pos += 1;
      const next = this.peek().charCodeAt(0);
      if (next >= 48 && next <= 57) this.fail("leading zero in number");
    } else {
      const first = this.peek().charCodeAt(0);
      if (!(first >= 49 && first <= 57)) this.fail("expected a JSON value");
      while (!this.atEnd()) {
        const code = this.peek().charCodeAt(0);
        if (code < 48 || code > 57) break;
        this.pos += 1;
      }
    }

    if (this.peek() === ".") {
      this.pos += 1;
      const firstFraction = this.peek().charCodeAt(0);
      if (!(firstFraction >= 48 && firstFraction <= 57)) this.fail("expected digit after decimal point");
      while (!this.atEnd()) {
        const code = this.peek().charCodeAt(0);
        if (code < 48 || code > 57) break;
        this.pos += 1;
      }
    }

    const exponent = this.peek();
    if (exponent === "e" || exponent === "E") {
      this.pos += 1;
      if (this.peek() === "+" || this.peek() === "-") this.pos += 1;
      const firstExponent = this.peek().charCodeAt(0);
      if (!(firstExponent >= 48 && firstExponent <= 57)) this.fail("expected digit in exponent");
      while (!this.atEnd()) {
        const code = this.peek().charCodeAt(0);
        if (code < 48 || code > 57) break;
        this.pos += 1;
      }
    }

    const raw = this.text.slice(start, this.pos);
    // JSON.parse accepts a grammatically valid exponent that overflows the
    // host number type (1e400 -> Infinity); JSON.stringify later renders that
    // value as null. Preserve that behavior rather than rejecting valid JSON.
    return Number(raw);
  }

  readValue(depth: number): Json {
    if (depth > 200) this.fail("JSON nested too deeply");
    this.skipWhitespace();
    const ch = this.peek();
    if (ch === "") {
      this.fail("unexpected end of input");
      return jnull();
    }
    if (ch === "{") {
      this.pos += 1;
      const obj = jobj();
      this.skipWhitespace();
      if (this.peek() === "}") {
        this.pos += 1;
        return obj;
      }
      while (true) {
        this.skipWhitespace();
        const key = this.readString();
        this.skipWhitespace();
        this.expect(":");
        obj.set(key, this.readValue(depth + 1));
        this.skipWhitespace();
        const sep = this.peek();
        if (sep === ",") {
          this.pos += 1;
          continue;
        }
        if (sep === "}") {
          this.pos += 1;
          return obj;
        }
        this.fail("expected ',' or '}'");
        return obj;
      }
    }
    if (ch === "[") {
      this.pos += 1;
      const arr = jarr();
      this.skipWhitespace();
      if (this.peek() === "]") {
        this.pos += 1;
        return arr;
      }
      while (true) {
        arr.items.push(this.readValue(depth + 1));
        this.skipWhitespace();
        const sep = this.peek();
        if (sep === ",") {
          this.pos += 1;
          continue;
        }
        if (sep === "]") {
          this.pos += 1;
          return arr;
        }
        this.fail("expected ',' or ']'");
        return arr;
      }
    }
    if (ch === '"') return jstr(this.readString());
    if (this.literal("true")) return jbool(true);
    if (this.literal("false")) return jbool(false);
    if (this.literal("null")) return jnull();
    return jnum(this.readNumber());
  }
}

/** Parse JSON text into a `Json` tree. Throws `JsonError` on malformed input. */
export function parseJson(text: string): Json {
  const reader = new JsonReader(text);
  const value = reader.readValue(0);
  reader.skipWhitespace();
  if (!reader.atEnd()) reader.fail("trailing content after JSON value");
  return value;
}
