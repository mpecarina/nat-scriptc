/**
 * Structured parsers for Arista EOS `show` commands.
 *
 * EOS runs the verb directly over SSH (no op-mode wrapper, unlike VyOS), so the
 * transport collects a plain transcript and these parsers give it the same
 * self-describing shape as the SONiC set:
 *
 *   show version            -> { kind: "eos.version",         … }
 *   show interfaces status  -> { kind: "eos.interfaceStatus", interfaces: […] }
 *   show ip interface brief -> { kind: "eos.ipInterfaces",    interfaces: […] }
 *   show ip route           -> { kind: "eos.ipRoute",         routes: […] }
 *   show lldp neighbors     -> { kind: "eos.lldpNeighbors",   neighbors: […] }
 *
 * Tables are read token-first, anchored on unambiguous columns (the interface
 * name, the status verb, a numeric TTL) rather than fixed header offsets, so a
 * frequently blank cell — the `Name` column of `show interfaces status` — does
 * not shift the fields.
 */

import { Json, jarr, jobj, jstr } from "./json.ts";
import { ParserContext } from "./models.ts";
import { deviceLines, findToken, kindList, kindObject } from "./parse-util.ts";
import { group, hasGroup } from "./text.ts";

const CIDR = /^\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}$/;

/** EOS interface-name prefixes; tells data rows from headers and separators. */
const IFACE = /^(Ethernet|Et|Management|Ma|Port-?Channel|Po|Vlan|Loopback|Lo|Vxlan|Vx|Tunnel|Tu)\d/i;

/** EOS `show interfaces status` link states — the anchor column. */
const IF_STATUS = /^(connected|notconnect|disabled|errdisabled|unconfigured|unconfig|dormant|up|down)$/i;

/** EOS RIB protocol codes → neutral names (one leading code letter). */
function eosProtocol(code: string): string {
  if (code === "C") return "connected";
  if (code === "S") return "static";
  if (code === "K") return "kernel";
  if (code === "O") return "ospf";
  if (code === "B") return "bgp";
  if (code === "R") return "rip";
  if (code === "i" || code === "I") return "isis";
  if (code === "A") return "aggregate";
  if (code === "M") return "martian";
  if (code === "V") return "vxlan";
  return code.toLowerCase();
}

/**
 * `show version` → identity fields. EOS prints the model on its own first line
 * followed by `Key: value` rows; both are captured (the raw pairs in `fields`,
 * plus the normalized top-level fields consumers read directly).
 */
export function parseEosVersion(raw: string, ctx: ParserContext): Json {
  const fields = jobj();
  let model = "";
  let modelSeen = false;
  for (const line of deviceLines(raw)) {
    const m = line.match(/^([A-Za-z][A-Za-z0-9 ._/()-]+?)\s*:\s*(.+)$/);
    if (m !== null) {
      const key = m[1].trim();
      if (!fields.has(key)) fields.setStr(key, m[2].trim());
      continue;
    }
    if (!modelSeen && !line.includes(":") && /\S/.test(line)) {
      model = line.trim();
      modelSeen = true;
    }
  }
  const totalMem = fields.str("Total memory", "");
  let totalMemoryKb: number | null = null;
  if (totalMem !== "") {
    const digits = totalMem.match(/(\d+)/);
    if (digits !== null) {
      const value = Number(digits[1]);
      if (Number.isFinite(value) && value !== 0) totalMemoryKb = value;
    }
  }

  const node = kindObject("eos.version");
  const resolvedModel = model !== "" ? model : fields.str("Model", "");
  node.setOptStr("model", resolvedModel);
  node.setOptStr("softwareImageVersion", fields.str("Software image version", ""));
  node.setOptStr("architecture", fields.str("Architecture", ""));
  node.setOptStr("systemMacAddress", fields.str("System MAC address", ""));
  node.setOptStr("hardwareMacAddress", fields.str("Hardware MAC address", ""));
  node.setOptStr("serialNumber", fields.str("Serial number", ""));
  node.setOptStr("uptime", fields.str("Uptime", ""));
  node.setOptNum("totalMemoryKb", totalMemoryKb);
  node.set("fields", fields);
  return node;
}

/**
 * `show interfaces status` → per-port L1/L2 status. Columns:
 *   Port Name Status Vlan Duplex Speed Type [Flags Encapsulation]
 * The `Name` cell is frequently blank, so rows anchor on the status verb:
 * everything before it (after the port) is the name, everything after is
 * Vlan / Duplex / Speed / Type.
 */
export function parseEosInterfacesStatus(raw: string, ctx: ParserContext): Json {
  const interfaces: Json[] = [];
  for (const line of deviceLines(raw)) {
    const t = line.trim().split(/\s+/);
    if (t.length === 0 || !IFACE.test(t[0])) continue;
    const statusIdx = findToken(t, IF_STATUS, 1);
    if (statusIdx < 0) continue;
    const rest = t.slice(statusIdx + 1);
    const entry = jobj();
    entry.setStr("port", t[0]);
    entry.setOptStr("name", t.slice(1, statusIdx).join(" "));
    entry.setStr("status", t[statusIdx].toLowerCase());
    entry.setOptStr("vlan", rest.length > 0 ? rest[0] : "");
    entry.setOptStr("duplex", rest.length > 1 ? rest[1] : "");
    entry.setOptStr("speed", rest.length > 2 ? rest[2] : "");
    entry.setOptStr("type", rest.slice(3).join(" "));
    interfaces.push(entry);
  }
  return kindList("eos.interfaceStatus", "interfaces", interfaces);
}

/**
 * `show ip interface brief` → interface → address and admin/oper state.
 * Columns: Interface IP-Address Status Protocol MTU [Owner]. `unassigned` (or
 * any non-CIDR token) yields an empty address list.
 */
export function parseEosIpInterfaceBrief(raw: string, ctx: ParserContext): Json {
  const interfaces: Json[] = [];
  for (const line of deviceLines(raw)) {
    const t = line.trim().split(/\s+/);
    if (t.length < 4 || !IFACE.test(t[0])) continue;
    const addresses = jarr();
    if (CIDR.test(t[1])) addresses.push(jstr(t[1]));
    // The MTU column is optional and may be absent or unparsable; a NaN
    // sentinel would ride into the IR, which the serializer refuses.
    let mtu: number | null = null;
    if (t.length > 4) {
      const parsed = Number(t[4]);
      if (Number.isFinite(parsed) && parsed !== 0) mtu = parsed;
    }

    const entry = jobj();
    entry.setStr("name", t[0]);
    entry.set("addresses", addresses);
    entry.setOptStr("adminStatus", t[2].toLowerCase());
    entry.setOptStr("operStatus", t[3].toLowerCase());
    entry.setOptNum("mtu", mtu);
    interfaces.push(entry);
  }
  return kindList("eos.ipInterfaces", "interfaces", interfaces);
}

/** A route being read, so its ECMP continuation lines attach to it. */
class PendingRoute {
  prefix: string;
  protocol: string;
  adminDistance: number;
  metric: number;

  constructor(prefix: string, protocol: string, adminDistance: number, metric: number) {
    this.prefix = prefix;
    this.protocol = protocol;
    this.adminDistance = adminDistance;
    this.metric = metric;
  }
}

function routeFromPending(pending: PendingRoute): Json {
  const route = jobj();
  route.setStr("prefix", pending.prefix);
  route.setStr("protocol", pending.protocol);
  route.setNum("adminDistance", pending.adminDistance);
  route.setNum("metric", pending.metric);
  return route;
}

/**
 * `show ip route` → normalized routes. The single-line forms:
 *   C        10.0.2.0/24 is directly connected, Management1
 *   S        0.0.0.0/0 [1/0] via 10.0.2.2, Management1
 *   O        10.1.0.0/24 [110/20] via 10.0.2.2, Ethernet1
 * and ECMP paths, whose extra next-hops print on indented continuation lines —
 * either after an inline first hop, or with every hop on its own line beneath a
 * bare `[AD/metric]` header. Each next-hop becomes its own route entry.
 */
export function parseEosRoutes(raw: string, ctx: ParserContext): Json {
  const routes: Json[] = [];
  let vrf = "";
  let pending: PendingRoute | null = null;

  for (const line of deviceLines(raw)) {
    const trimmed = line.trim();
    const vrfM = trimmed.match(/^VRF:\s*(\S+)/);
    if (vrfM !== null) {
      vrf = vrfM[1];
      pending = null;
      continue;
    }
    if (/^Codes:/.test(trimmed) || /^Gateway of last resort/i.test(trimmed)) continue;

    const m = line.match(/^\s*([A-Za-z])[A-Za-z0-9 ]{0,3}?[>*\s]+(\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2})\s*(.*)$/);
    if (m === null) {
      // ECMP continuation: an indented `via <ip>[, <iface>]` for the pending prefix.
      const cont = line.match(/^\s+via\s+(\d{1,3}(?:\.\d{1,3}){3})(?:,\s*([A-Za-z0-9._/-]+))?/);
      if (cont !== null && pending !== null) {
        const route = routeFromPending(pending);
        route.setStr("nextHopIp", cont[1]);
        if (hasGroup(cont, 2)) route.setStr("outgoingInterface", group(cont, 2));
        routes.push(route);
        continue;
      }
      // Connected continuation: EOS prints `directly connected, <iface>` on an
      // indented line beneath a bare `C <prefix>` header.
      const connCont = line.match(/^\s+(?:is\s+)?directly connected,\s*([A-Za-z0-9._/-]+)/);
      if (connCont !== null && pending !== null) {
        const route = routeFromPending(pending);
        route.setStr("outgoingInterface", connCont[1]);
        routes.push(route);
      }
      continue;
    }

    const prefix = m[2];
    const rest = m[3];
    const protocol = eosProtocol(m[1]);
    const route = jobj();
    route.setStr("prefix", prefix);
    route.setStr("protocol", protocol);
    let adminDistance = 0;
    let metric = 0;
    const ad = rest.match(/\[(\d+)\/(\d+)\]/);
    if (ad !== null) {
      adminDistance = Number(ad[1]);
      metric = Number(ad[2]);
    }
    route.setNum("adminDistance", adminDistance);
    route.setNum("metric", metric);

    const via = rest.match(/via\s+(\d{1,3}(?:\.\d{1,3}){3})/);
    if (via !== null) route.setStr("nextHopIp", via[1]);
    const conn = rest.match(/directly connected,\s*([A-Za-z0-9._/-]+)/);
    const viaIf = rest.match(/via\s+\d{1,3}(?:\.\d{1,3}){3},\s*([A-Za-z0-9._/-]+)/);
    let iface = "";
    if (conn !== null) iface = conn[1];
    else if (viaIf !== null) iface = viaIf[1];
    if (iface !== "") route.setStr("outgoingInterface", iface);

    // A routed entry (inline via) or a bare header — an OSPF `[AD/metric]`, or
    // a connected prefix whose interface prints on the next line — seeds the
    // pending context so continuation lines clone it; an inline
    // `directly connected` route is terminal and needs no continuation.
    pending = conn !== null ? null : new PendingRoute(prefix, protocol, adminDistance, metric);
    if (via !== null || conn !== null) routes.push(route);
  }

  const node = kindObject("eos.ipRoute");
  node.setOptStr("vrf", vrf);
  const list = jarr();
  for (const route of routes) list.push(route);
  node.set("routes", list);
  return node;
}

/**
 * `show lldp neighbors` → neighbour rows. Columns (multi-word, blank-friendly):
 *   Port  Neighbor Device ID  Neighbor Port ID  TTL
 * The trailing integer TTL and the local Port anchor the row; the remaining
 * middle tokens are the neighbour's device id (all but the last) and port id
 * (the last), since neighbour port ids are single tokens.
 */
export function parseEosLldpNeighbors(raw: string, ctx: ParserContext): Json {
  const neighbors: Json[] = [];
  for (const line of deviceLines(raw)) {
    const t = line.trim().split(/\s+/);
    if (t.length < 3 || !IFACE.test(t[0])) continue;
    const last = t[t.length - 1];
    const hasTtl = /^\d+$/.test(last);
    const mid = hasTtl ? t.slice(1, t.length - 1) : t.slice(1);
    if (mid.length === 0) continue;
    const entry = jobj();
    entry.setStr("localPort", t[0]);
    entry.setStr("neighborDevice", mid.length >= 2 ? mid.slice(0, mid.length - 1).join(" ") : mid[0]);
    entry.setOptStr("neighborPort", mid.length >= 2 ? mid[mid.length - 1] : "");
    entry.setOptNum("ttl", hasTtl ? Number(last) : null);
    neighbors.push(entry);
  }
  return kindList("eos.lldpNeighbors", "neighbors", neighbors);
}
