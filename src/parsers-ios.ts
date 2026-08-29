/**
 * src/parsers-ios.ts — structured parsers for Cisco IOS / IOS-XE `show` output.
 *
 * IOS-XE presents a classic Cisco CLI, so the transport collects a plain
 * transcript and these parsers give it the same self-describing shape as the
 * EOS and SONiC sets:
 *
 *   show version              -> { kind: "ios.version",      … }
 *   show ip interface brief   -> { kind: "ios.ipInterfaces", interfaces: […] }
 *   show ip route             -> { kind: "ios.ipRoute",      routes: […] }
 *   show cdp neighbors detail -> { kind: "ios.cdpNeighbors", neighbors: […] }
 *
 * IOS quirks these absorb:
 *  - `show ip interface brief` prints the IP with NO mask, so the address is
 *    the bare host IP; a consumer reconstructs the CIDR by correlating the
 *    interface with its `connected` route in the RIB.
 *  - `show ip route` groups routes under a classful `… is variably subnetted`
 *    header, prints a leading protocol code, and lays ECMP paths on
 *    `[AD/metric] via …` continuation lines beneath the prefix.
 *  - Cisco's native neighbour discovery is CDP (LLDP is often off), so
 *    `show cdp neighbors detail` is the authoritative adjacency source.
 */

import { Json, jarr, jobj, jstr } from "./json.ts";
import { ParserContext } from "./models.ts";
import { deviceLines, kindList, kindObject } from "./parse-util.ts";
import { group, hasGroup } from "./text.ts";

const IP_SOURCE = "\\d{1,3}(?:\\.\\d{1,3}){3}";
const IPX = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * IOS interface-name prefixes (full and abbreviated); tells data rows from
 * headers and separators.
 */
const IFACE =
  /^(GigabitEthernet|TenGigabitEthernet|FortyGigE|FastEthernet|Ethernet|Gi|Te|Fo|Fa|Eth?|Loopback|Lo|Port-?channel|Po|Tunnel|Tu|Vlan|Vl|Serial|Se|Management|Mgmt)\d/i;

/** IOS RIB protocol codes → neutral names (the row's leading code letter). */
export function iosProtocol(code: string): string {
  if (code === "C") return "connected";
  if (code === "S") return "static";
  if (code === "L") return "local";
  if (code === "O" || code === "N") return "ospf";
  if (code === "B") return "bgp";
  if (code === "D") return "eigrp";
  if (code === "R") return "rip";
  if (code === "i") return "isis";
  if (code === "I") return "igrp";
  if (code === "E") return "egp";
  if (code === "M") return "mobile";
  if (code === "o") return "odr";
  if (code === "P") return "periodic";
  if (code === "H") return "nhrp";
  if (code === "G") return "replicated";
  return "";
}

/** True when `code` is a known IOS RIB protocol letter. */
function isIosCode(code: string): boolean {
  return iosProtocol(code) !== "";
}

/** The first capture group of `pattern` in `text`, trimmed, or "". */
function grab(text: string, pattern: RegExp): string {
  const m = text.match(pattern);
  if (m === null) return "";
  return group(m, 1).trim();
}

/**
 * `show version` → identity fields. IOS-XE prints prose, not key/value rows, so
 * each field is pulled with an anchored pattern:
 *   Cisco IOS XE Software, Version 17.03.05
 *   cisco CSR1000V (VXE) processor (revision VXE) with … bytes of memory.
 *   Processor board ID 9SAGBWY7QHD
 *   <hostname> uptime is 1 hour, 12 minutes
 *   System image file is "bootflash:packages.conf"
 */
export function parseIosVersion(raw: string, ctx: ParserContext): Json {
  const text = deviceLines(raw).join("\n");
  let version = grab(text, /Cisco IOS XE Software,\s*Version\s+([0-9][0-9A-Za-z.()]*)/i);
  if (version === "") version = grab(text, /,\s*Version\s+([0-9][0-9A-Za-z.()]*)/i);
  const up = text.match(/^(\S+)\s+uptime is\s+(.+)$/im);

  const node = kindObject("ios.version");
  node.setOptStr("model", grab(text, /^cisco\s+(\S+)\s+\([^)]*\)\s+processor/im));
  node.setOptStr("version", version);
  // A twin-friendly alias, so consumers read the same field name as eos.version.
  node.setOptStr("softwareImageVersion", version);
  node.setOptStr("softwareTrain", grab(text, /Cisco IOS Software \[([^\]]+)\]/i));
  node.setOptStr("softwareImage", grab(text, /\(([A-Z0-9_-]+-M)\),\s*Version/i));
  node.setOptStr("hostname", up === null ? "" : up[1]);
  node.setOptStr("uptime", up === null ? "" : up[2].trim());
  node.setOptStr("serialNumber", grab(text, /Processor board ID\s+(\S+)/i));
  node.setOptStr("systemImageFile", grab(text, /System image file is\s+"([^"]+)"/i));
  return node;
}

/**
 * `show ip interface brief` → interface → address and admin/oper state.
 * Columns: Interface IP-Address OK? Method Status Protocol. IOS omits the
 * prefix length, so `ipAddress` is the bare host IP (or null for `unassigned`);
 * the row anchors on the `OK?` column so a two-word Status ("administratively
 * down") does not shift the fields.
 */
export function parseIosIpInterfaceBrief(raw: string, ctx: ParserContext): Json {
  const interfaces: Json[] = [];
  for (const line of deviceLines(raw)) {
    const t = line.trim().split(/\s+/);
    if (t.length < 5 || !IFACE.test(t[0]) || !/^(YES|NO)$/i.test(t[2])) continue;
    const protocol = t[t.length - 1].toLowerCase();
    const status = t.slice(4, t.length - 1).join(" ");
    const entry = jobj();
    entry.setStr("name", t[0]);
    entry.setStrOrNull("ipAddress", IPX.test(t[1]) ? t[1] : null);
    entry.setStr("method", t[3]);
    entry.setStr("status", status.toLowerCase());
    entry.setStr("adminStatus", /down/i.test(status) ? "down" : "up");
    entry.setStr("operStatus", protocol);
    interfaces.push(entry);
  }
  return kindList("ios.ipInterfaces", "interfaces", interfaces);
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

/**
 * `show ip route` → normalized routes. The common forms:
 *   C        10.0.10.0/24 is directly connected, GigabitEthernet1
 *   L        10.0.10.1/32 is directly connected, GigabitEthernet1
 *   S*    0.0.0.0/0 [1/0] via 192.168.122.1
 *   O        10.0.20.0/24 [110/2] via 10.1.12.2, 00:05:12, GigabitEthernet2
 * and ECMP paths, whose extra next-hops print on `[AD/metric] via …`
 * continuation lines beneath the prefix. Each next-hop becomes its own route
 * entry. Classful `… is variably subnetted` group headers, the `Codes:` legend
 * and `Gateway of last resort` are skipped; `local` (/32 interface) routes are
 * emitted with protocol "local" so consumers can drop them.
 */
export function parseIosRoutes(raw: string, ctx: ParserContext): Json {
  const routes: Json[] = [];
  let vrf = "";
  let pending: PendingRoute | null = null;
  const viaRe = new RegExp(`via\\s+(${IP_SOURCE})`);
  const contRe = new RegExp(
    `^\\s+(?:\\[(\\d+)\\/(\\d+)\\]\\s+)?via\\s+(${IP_SOURCE})(?:,[^,]*)*,\\s*([A-Za-z][A-Za-z0-9._/-]*)\\s*$`,
  );

  for (const line of deviceLines(raw)) {
    const t = line.trim();
    if (/^Codes:/i.test(t) || /^Gateway of last resort/i.test(t)) continue;
    const vrfM = t.match(/^Routing Table:\s*(\S+)/i);
    if (vrfM !== null) {
      vrf = vrfM[1] === "default" ? "" : vrfM[1];
      pending = null;
      continue;
    }
    if (/\bis (?:variably )?subnetted\b/i.test(t)) continue;

    // Primary line: leading protocol code, optional `*`, the prefix, then rest.
    const m = line.match(/^\s*([A-Za-z][A-Za-z0-9 ]{0,5}?)\*?\s+(\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2})\b\s*(.*)$/);
    if (m !== null && isIosCode(m[1].trim().charAt(0))) {
      const code = m[1].trim();
      const prefix = m[2];
      const rest = m[3];
      const protocol = iosProtocol(code.charAt(0));
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

      const via = rest.match(viaRe);
      if (via !== null) route.setStr("nextHopIp", via[1]);
      const conn = rest.match(/directly connected,\s*([A-Za-z][A-Za-z0-9._/-]*)/);
      const viaIf = rest.match(/,\s*([A-Za-z][A-Za-z0-9._/-]*)\s*$/);
      let iface = "";
      if (conn !== null) iface = conn[1];
      else if (via !== null && viaIf !== null) iface = viaIf[1];
      if (iface !== "") route.setStr("outgoingInterface", iface);

      // A routed entry (inline via) or a bare `[AD/metric]` header seeds the
      // pending context so following ECMP continuation lines clone it.
      pending =
        via !== null || (ad !== null && conn === null)
          ? new PendingRoute(prefix, protocol, adminDistance, metric)
          : null;
      if (via !== null || conn !== null) routes.push(route);
      continue;
    }

    // ECMP continuation: `[AD/metric] via <ip>[, timer], <iface>`, or a bare
    // `via <ip>, <iface>`, belonging to the pending prefix.
    const cont = line.match(contRe);
    if (cont === null || pending === null) continue;
    const route = jobj();
    route.setStr("prefix", pending.prefix);
    route.setStr("protocol", pending.protocol);
    route.setNum("adminDistance", hasGroup(cont, 1) ? Number(group(cont, 1)) : pending.adminDistance);
    route.setNum("metric", hasGroup(cont, 2) ? Number(group(cont, 2)) : pending.metric);
    route.setStr("nextHopIp", group(cont, 3));
    if (hasGroup(cont, 4)) route.setStr("outgoingInterface", group(cont, 4));
    routes.push(route);
  }

  const node = kindObject("ios.ipRoute");
  node.setOptStr("vrf", vrf);
  const list = jarr();
  for (const route of routes) list.push(route);
  node.set("routes", list);
  return node;
}

/**
 * `show cdp neighbors detail` → neighbour rows. Each neighbour is a block set
 * off by a dashed separator; the fields topology needs are:
 *   Device ID: csr2.lab
 *     IP address: 10.1.12.2
 *   Platform: Cisco CSR1000V,  Capabilities: Router
 *   Interface: GigabitEthernet2,  Port ID (outgoing port): GigabitEthernet1
 */
export function parseIosCdpNeighbors(raw: string, ctx: ParserContext): Json {
  const neighbors: Json[] = [];
  let current: Json | null = null;
  let hasMgmtAddress = false;

  for (const line of deviceLines(raw)) {
    const t = line.trim();
    if (/^-{3,}$/.test(t)) {
      if (current !== null && current.str("neighborDevice", "") !== "") neighbors.push(current);
      current = null;
      continue;
    }
    const dev = t.match(/^Device ID:\s*(.+)$/i);
    if (dev !== null) {
      if (current !== null && current.str("neighborDevice", "") !== "") neighbors.push(current);
      current = jobj().setStr("neighborDevice", dev[1].trim());
      hasMgmtAddress = false;
      continue;
    }
    if (current === null) continue;

    const ip = t.match(/^IP address:\s*(\d{1,3}(?:\.\d{1,3}){3})/i);
    if (ip !== null && !hasMgmtAddress) {
      current.setStr("mgmtAddress", ip[1]);
      hasMgmtAddress = true;
      continue;
    }
    const plat = t.match(/^Platform:\s*([^,]+?)(?:,\s*Capabilities:\s*(.+))?$/i);
    if (plat !== null) {
      current.setStr("platform", plat[1].trim());
      if (hasGroup(plat, 2)) {
        const caps = jarr();
        for (const cap of group(plat, 2).trim().split(/\s+/)) caps.push(jstr(cap));
        current.set("capabilities", caps);
      }
      continue;
    }
    const intf = t.match(/^Interface:\s*([^,]+),\s*Port ID \(outgoing port\):\s*(.+)$/i);
    if (intf !== null) {
      current.setStr("localInterface", intf[1].trim());
      current.setStr("neighborPort", intf[2].trim());
      continue;
    }
    const hold = t.match(/^Holdtime\s*:\s*(\d+)/i);
    if (hold !== null) current.setNum("holdtime", Number(hold[1]));
  }
  if (current !== null && current.str("neighborDevice", "") !== "") neighbors.push(current);
  return kindList("ios.cdpNeighbors", "neighbors", neighbors);
}
