/**
 * The driver-neutral parsers.
 *
 * These back the `generic` and `linux` drivers and act as the fallback for
 * every other driver: key/value extraction, whitespace tables, `ls -l`
 * listings, and the iproute2 address/route reads that let a Linux host
 * contribute its interfaces and routes the same way a router does.
 *
 * The VyOS parsers live here too: VyOS is a Linux router whose op-mode output
 * shares these shapes.
 */

import { Json, jarr, jnull, jobj, jstr } from "./json.ts";
import { ParserContext } from "./models.ts";
import { headerKey, plainList, splitColumns } from "./parse-util.ts";
import { group, hasGroup, splitLines } from "./text.ts";

/** Generic parser: `key: value` / `key = value` pairs plus the raw lines. */
export function parseKeyValue(raw: string, ctx: ParserContext): Json {
  const lines = jarr();
  const fields = jobj();
  for (const rawLine of splitLines(raw)) {
    const line = rawLine.trim();
    if (line === "") continue;
    lines.push(jstr(line));
    const m = line.match(/^([A-Za-z0-9 ._\-/]+?)\s*[:=]\s*(.+)$/);
    if (m === null) continue;
    const key = m[1].trim();
    if (key !== "" && !fields.has(key)) fields.setStr(key, m[2].trim());
  }
  return jobj().set("fields", fields).set("lines", lines);
}

/**
 * Generic whitespace-delimited table (`df -h`, `ps aux`). The first non-empty
 * line is the header. The column count comes from the narrowest data row, so a
 * multi-word header (`Mounted on`) merges into the final column instead of
 * producing a stray one; when data rows are wider than the header (`ps`'s
 * COMMAND), the last column absorbs the remaining text.
 */
export function parseTable(raw: string, ctx: ParserContext): Json {
  const lines: string[] = [];
  for (const rawLine of splitLines(raw)) {
    const line = rawLine.replace(/\s+$/, "");
    if (line.trim() !== "") lines.push(line);
  }
  if (lines.length === 0) {
    return jobj().set("columns", jarr()).set("rows", jarr());
  }

  const headerTokens = lines[0].trim().split(/\s+/);
  const dataLines = lines.slice(1);

  let colCount = headerTokens.length;
  if (dataLines.length > 0) {
    let minData = -1;
    for (const line of dataLines) {
      const width = line.trim().split(/\s+/).length;
      if (minData < 0 || width < minData) minData = width;
    }
    if (minData >= 1 && minData < headerTokens.length) colCount = minData;
  }

  const headerNames = headerTokens.slice(0, colCount - 1);
  headerNames.push(headerTokens.slice(colCount - 1).join(" "));
  const columns: string[] = [];
  for (const name of headerNames) columns.push(headerKey(name));

  const columnList = jarr();
  for (const column of columns) columnList.push(jstr(column));

  const rows = jarr();
  for (const line of dataLines) {
    const parts = splitColumns(line, colCount);
    const row = jobj();
    for (let index = 0; index < columns.length; index += 1) {
      const value = index < parts.length ? parts[index] : "";
      row.set(columns[index], index < parts.length ? jstr(value) : jnull());
    }
    rows.push(row);
  }
  return jobj().set("columns", columnList).set("rows", rows);
}

const LS_LINE =
  /^([dlbcps-][rwxsStT-]{9}[.+@]*)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\w{3}\s+\d+\s+[\d:]+)\s+(.+)$/;

function lsTypeFor(marker: string): string {
  if (marker === "d") return "dir";
  if (marker === "l") return "symlink";
  if (marker === "-") return "file";
  if (marker === "b") return "block";
  if (marker === "c") return "char";
  if (marker === "p") return "fifo";
  if (marker === "s") return "socket";
  return "other";
}

/** Parse `ls -l` / `ls -lh` long listings into structured entries. */
export function parseLs(raw: string, ctx: ParserContext): Json {
  const entries: Json[] = [];
  for (const rawLine of splitLines(raw)) {
    const line = rawLine.trim();
    if (line === "" || /^total\b/i.test(line)) continue;
    const m = line.match(LS_LINE);
    if (m === null) continue;
    const perms = m[1];
    const nameField = m[7];
    let name = nameField;
    let target: string | null = null;
    if (perms.charAt(0) === "l" && nameField.includes(" -> ")) {
      const idx = nameField.indexOf(" -> ");
      name = nameField.slice(0, idx);
      target = nameField.slice(idx + 4);
    }
    const entry = jobj();
    entry.setStr("type", lsTypeFor(perms.charAt(0)));
    entry.setStr("perms", perms);
    entry.setNum("links", Number(m[2]));
    entry.setStr("owner", m[3]);
    entry.setStr("group", m[4]);
    entry.setStr("size", m[5]);
    entry.setStr("date", m[6]);
    entry.setStr("name", name);
    entry.setStrOrNull("target", target);
    entries.push(entry);
  }
  return plainList("entries", entries);
}

function vyosProtocol(code: string): string {
  if (code === "K") return "kernel";
  if (code === "C") return "connected";
  if (code === "S") return "static";
  if (code === "R") return "rip";
  if (code === "O") return "ospf";
  if (code === "I") return "isis";
  if (code === "B") return "bgp";
  if (code === "L") return "local";
  if (code === "T") return "table";
  if (code === "D") return "sharp";
  if (code === "A") return "babel";
  return code.toLowerCase();
}

/** Attach `[admin/metric]` and `via` / `directly connected` hops to a route. */
function vyosAddNextHops(route: Json, nextHops: Json, rest: string): void {
  if (rest === "") return;
  const admin = rest.match(/\[(\d+)\/(\d+)\]/);
  if (admin !== null) {
    route.setNum("distance", Number(admin[1]));
    route.setNum("metric", Number(admin[2]));
  }
  const connected = rest.match(/is directly connected,\s*([A-Za-z0-9._-]+)/);
  if (connected !== null) {
    nextHops.push(jobj().set("via", jnull()).setStr("interface", connected[1]).setBool("connected", true));
    return;
  }
  const via = rest.match(/via\s+([0-9a-fA-F:.]+),?\s*([A-Za-z0-9._-]+)?/);
  if (via !== null) {
    const hop = jobj().setStr("via", via[1]);
    const iface = group(via, 2);
    hop.setStrOrNull("interface", iface === "" ? null : iface);
    hop.setBool("connected", false);
    nextHops.push(hop);
  }
}

/**
 * Parse VyOS `show ip route` (FRR/zebra RIB output):
 *   S>* 10.50.2.0/24 [1/0] via 10.50.0.2, eth2
 *   C>* 10.50.1.0/24 is directly connected, eth1
 *   O   10.0.0.0/8  [110/10] via 10.0.0.1, eth0
 * plus the indented continuation lines ECMP paths print. The leading code
 * letter selects the protocol; `>` marks the selected route and `*` the FIB
 * entry.
 */
export function parseVyosRoutes(raw: string, ctx: ParserContext): Json {
  const routes: Json[] = [];
  let current: Json | null = null;
  let currentHops: Json | null = null;
  for (const rawLine of splitLines(raw)) {
    const line = rawLine.replace(/\s+$/, "");
    if (line === "") continue;
    if (/^Codes:/i.test(line) || /^\s*[A-Za-z*]+\s+-\s+/.test(line)) continue;
    const head = line.match(/^([A-Z])[A-Z ]{0,3}?(>)?(\*)?\s+(\S+\/\d{1,3})\s*(.*)$/);
    if (head !== null) {
      const route = jobj();
      route.setStr("prefix", head[4]);
      route.setStr("protocol", vyosProtocol(head[1]));
      route.setBool("selected", hasGroup(head, 2));
      route.setBool("fib", hasGroup(head, 3));
      const hops = jarr();
      route.set("nextHops", hops);
      routes.push(route);
      current = route;
      currentHops = hops;
      vyosAddNextHops(route, hops, group(head, 5));
      continue;
    }
    // ECMP continuation lines carry extra next-hops for the previous route; the
    // FIB marker `*` may precede `via`.
    if (current !== null && currentHops !== null && /^\s+(\*\s+)?(via|is directly connected)/.test(line)) {
      vyosAddNextHops(current, currentHops, line.trim());
    }
  }
  return plainList("routes", routes);
}

/**
 * Parse VyOS `show interfaces`. Two column layouts exist across versions — the
 * fuller `Interface IP-Address MAC VRF MTU S/L [Description]` and the leaner
 * `Interface IP-Address S/L [Description]` — so extraction is pattern-based
 * (find the CIDR, the MAC, a standalone MTU integer and the `S/L` token) rather
 * than positional. Absent fields are null.
 */
export function parseVyosInterfaces(raw: string, ctx: ParserContext): Json {
  const interfaces: Json[] = [];
  for (const rawLine of splitLines(raw)) {
    const line = rawLine.replace(/\s+$/, "");
    if (line === "") continue;
    if (/^Codes:/i.test(line) || /^\s*[A-Za-z]\s+-\s+/.test(line)) continue;
    if (/^Interface\b/i.test(line)) continue;
    if (/^[-\s]+$/.test(line)) continue;
    const cols = line.trim().split(/\s+/);
    if (cols.length < 2 || !/^[A-Za-z]/.test(cols[0])) continue;
    const rest = cols.slice(1);

    let address = "";
    let mac = "";
    let mtu = "";
    for (const token of rest) {
      if (address === "" && (/^\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}$/.test(token) || /^[0-9a-fA-F:]+\/\d{1,3}$/.test(token))) {
        address = token;
      }
      if (mac === "" && /^[0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5}$/.test(token)) mac = token;
      if (mtu === "" && /^\d{3,5}$/.test(token)) mtu = token;
    }

    let slIndex = -1;
    for (let i = 0; i < cols.length; i += 1) {
      if (/^[uAD]\/[uAD]$/.test(cols[i])) {
        slIndex = i;
        break;
      }
    }
    let state: string | null = null;
    let link: string | null = null;
    if (slIndex >= 0) {
      const parts = cols[slIndex].split("/");
      state = parts[0];
      link = parts.length > 1 ? parts[1] : null;
    }
    const description = slIndex >= 0 && cols.length > slIndex + 1 ? cols.slice(slIndex + 1).join(" ") : null;

    const entry = jobj();
    entry.setStr("name", cols[0]);
    entry.setStrOrNull("address", address !== "" && address !== "-" ? address : null);
    entry.setStrOrNull("mac", mac === "" ? null : mac);
    entry.setNumOrNull("mtu", mtu === "" ? null : Number(mtu));
    entry.setStrOrNull("state", state);
    entry.setStrOrNull("link", link);
    entry.setStrOrNull("description", description);
    interfaces.push(entry);
  }
  return plainList("interfaces", interfaces);
}

/**
 * Parse Linux `ip addr` into the same `{ interfaces: [...] }` shape
 * `parseVyosInterfaces` emits, so a Linux host is ingested exactly like a
 * router. The point-to-point form is the one that matters:
 *
 *   inet 100.64.10.15 peer 10.200.10.1/32 scope global ppp0
 *
 * The LOCAL address carries no prefix there (the /32 belongs to the peer), so
 * it is recorded as /32 with the peer kept alongside it.
 */
export function parseIpAddr(raw: string, ctx: ParserContext): Json {
  const interfaces: Json[] = [];
  let current: Json | null = null;
  let currentHasAddress = false;
  for (const rawLine of splitLines(raw)) {
    const line = rawLine.replace(/\s+$/, "");
    if (line === "") continue;
    // "9: ppp0: <POINTOPOINT,UP,LOWER_UP> mtu 1492 qdisc fq_codel state UNKNOWN"
    // "2: eth0@if3: <...>"  — the @parent suffix veth/macvlan pairs carry.
    const head = line.match(/^\d+:\s+([^:@\s]+)(?:@\S+)?:\s+<([^>]*)>(.*)$/);
    if (head !== null) {
      const flags = head[2].split(",");
      const rest = group(head, 3);
      const mtu = rest.match(/\bmtu\s+(\d+)/);
      const entry = jobj();
      entry.setStr("name", head[1]);
      entry.set("address", jnull());
      entry.set("mac", jnull());
      entry.setNumOrNull("mtu", mtu === null ? null : Number(mtu[1]));
      // Mirror VyOS's S/L codes: admin state and carrier, "u" or "D".
      entry.setStr("state", flags.includes("UP") ? "u" : "D");
      entry.setStr("link", flags.includes("LOWER_UP") ? "u" : "D");
      entry.set("description", jnull());
      interfaces.push(entry);
      current = entry;
      currentHasAddress = false;
      continue;
    }
    if (current === null) continue;
    const mac = line.match(/^\s*link\/(?:ether|infiniband)\s+([0-9a-fA-F]{2}(?::[0-9a-fA-F]{2})+)/);
    if (mac !== null) {
      current.setStr("mac", mac[1]);
      continue;
    }
    // The first address wins, so a secondary alias never displaces the primary.
    const inet = line.match(/^\s*inet6?\s+([0-9a-fA-F:.]+)(?:\/(\d{1,3}))?/);
    if (inet !== null && !currentHasAddress) {
      const peer = line.match(/\bpeer\s+([0-9a-fA-F:.]+)(?:\/(\d{1,3}))?/);
      const isV6 = /^\s*inet6\b/.test(line);
      const captured = group(inet, 2);
      const prefix = captured === "" ? (isV6 ? "128" : "32") : captured;
      current.setStr("address", `${inet[1]}/${prefix}`);
      currentHasAddress = true;
      if (peer !== null) {
        const peerPrefix = group(peer, 2);
        current.setStr("peer", peerPrefix === "" ? peer[1] : `${peer[1]}/${peerPrefix}`);
      }
    }
  }
  return plainList("interfaces", interfaces);
}

/**
 * Parse Linux `ip route` into the same `{ routes: [...] }` shape as
 * `parseVyosRoutes`. Every row `ip route` prints is installed and selected, so
 * `selected`/`fib` are both true.
 */
export function parseIpRoute(raw: string, ctx: ParserContext): Json {
  const routes: Json[] = [];
  for (const rawLine of splitLines(raw)) {
    const line = rawLine.trim();
    if (line === "" || /^__LOOM_EXIT_CODE__=/.test(line)) continue;
    const head = line.match(/^(default|[0-9a-fA-F:.]+(?:\/\d{1,3})?)\s*(.*)$/);
    if (head === null) continue;
    let prefix = head[1];
    const rest = group(head, 2);
    if (prefix === "default") {
      const ipv6 = /(?:^|\s)-6(?:\s|$)/.test(ctx.command) || /\bvia\s+[0-9a-fA-F]*:/.test(rest);
      prefix = ipv6 ? "::/0" : "0.0.0.0/0";
    }
    // A bare host route ("10.200.10.1 dev ppp0") is a /32 — normalized here so
    // the prefix column is always CIDR, matching the VyOS parser.
    else if (!prefix.includes("/")) prefix = `${prefix}/${prefix.includes(":") ? 128 : 32}`;
    const via = rest.match(/\bvia\s+([0-9a-fA-F:.]+)/);
    const dev = rest.match(/\bdev\s+([A-Za-z0-9._@-]+)/);
    const proto = rest.match(/\bproto\s+(\S+)/);
    const metric = rest.match(/\bmetric\s+(\d+)/);
    const src = rest.match(/\bsrc\s+([0-9a-fA-F:.]+)/);

    const route = jobj();
    route.setStr("prefix", prefix);
    route.setStr("protocol", proto === null ? "kernel" : proto[1]);
    route.setBool("selected", true);
    route.setBool("fib", true);
    const hop = jobj();
    hop.setStrOrNull("via", via === null ? null : via[1]);
    hop.setStrOrNull("interface", dev === null ? null : dev[1]);
    hop.setBool("connected", via === null);
    route.set("nextHops", jarr().push(hop));
    if (metric !== null) route.setNum("metric", Number(metric[1]));
    if (src !== null) route.setStr("src", src[1]);
    routes.push(route);
  }
  return plainList("routes", routes);
}

/**
 * Last-resort Unix parser: recognise iproute2 output by its SHAPE, then fall
 * back to key/value.
 *
 * A command can arrive wrapped beyond recognition — a caller that
 * base64-encodes the verb into a temp-file shim leaves no trace of `ip addr` in
 * the command string, so no glob can select the right parser. The output,
 * though, is unmistakable, so sniffing it keeps structured data flowing however
 * the verb was delivered.
 */
export function parseUnixAuto(raw: string, ctx: ParserContext): Json {
  if (/^\s*\d+:\s+[^:@\s]+(?:@\S+)?:\s+</m.test(raw)) return parseIpAddr(raw, ctx);
  const lines: string[] = [];
  for (const rawLine of splitLines(raw)) {
    const line = rawLine.trim();
    // A shell shim's own exit-code trailer is not part of the command's output,
    // so it must not veto the shape test.
    if (line === "" || /^__LOOM_EXIT_CODE__=/.test(line)) continue;
    lines.push(line);
  }
  if (lines.length > 0) {
    let allRoutes = true;
    for (const line of lines) {
      if (!/^(default\s+|[0-9a-fA-F:.]+(\/\d{1,3})?\s+)/.test(line) || !/\bdev\s+\S+/.test(line)) {
        allRoutes = false;
        break;
      }
    }
    if (allRoutes) return parseIpRoute(raw, ctx);
  }
  return parseKeyValue(raw, ctx);
}
