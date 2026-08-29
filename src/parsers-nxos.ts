/**
 * src/parsers-nxos.ts — structured parsers for Cisco NX-OS `show` output.
 *
 * These deliberately emit the `ios.*` shapes for the common twin-bearing
 * commands, so a consumer's existing Cisco assembler builds a routed Nexus
 * model without a second near-duplicate builder.
 */

import { Json, jarr, jobj } from "./json.ts";
import { ParserContext } from "./models.ts";
import { deviceLines, kindList, kindObject } from "./parse-util.ts";
import { group, hasGroup } from "./text.ts";

const IP_SOURCE = "\\d{1,3}(?:\\.\\d{1,3}){3}";
const IPX = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** Expand NX-OS's abbreviated interface names to their canonical spelling. */
function canonNxosIf(name: string): string {
  return name
    .trim()
    .replace(/^Eth(?=\d)/i, "Ethernet")
    .replace(/^Lo(?=\d)/i, "Loopback")
    .replace(/^Po(?=\d)/i, "Port-channel")
    .replace(/^mgmt(?=\d)/i, "mgmt");
}

/** The first capture group of `pattern` in `text`, trimmed, or "". */
function grab(text: string, pattern: RegExp): string {
  const m = text.match(pattern);
  if (m === null) return "";
  return group(m, 1).trim();
}

/** `show version` → identity fields, in the `ios.version` shape. */
export function parseNxosVersion(raw: string, ctx: ParserContext): Json {
  const text = deviceLines(raw).join("\n");
  let version = grab(text, /NXOS:\s*version\s+([^\s]+)/i);
  if (version === "") version = grab(text, /system:\s*version\s+([^\s]+)/i);
  if (version === "") version = grab(text, /Cisco Nexus Operating System.*?version\s+([^\s]+)/i);

  let model = grab(text, /cisco\s+(Nexus\S+|N9K\S+|\S+).*Chassis/i);
  if (model === "") model = grab(text, /Hardware\s+cisco\s+(\S+)/i);
  if (model === "") model = "Nexus";
  const image = grab(text, /NXOS image file is:\s*(\S+)/i);

  const node = kindObject("ios.version");
  node.setOptStr("model", model);
  node.setOptStr("version", version);
  node.setOptStr("softwareImageVersion", version);
  node.setOptStr("softwareImage", image);
  node.setOptStr("hostname", grab(text, /Device name:\s*(\S+)/i));
  node.setOptStr("uptime", grab(text, /Kernel uptime is\s+(.+)$/im));
  node.setOptStr(
    "serialNumber",
    grab(text, /(?:Processor Board ID|System serial number|Chassis serial number)\s*[:=]?\s*(\S+)/i),
  );
  node.setOptStr("systemImageFile", image);
  return node;
}

/** `show ip interface brief` → the `ios.ipInterfaces` shape. */
export function parseNxosIpInterfaceBrief(raw: string, ctx: ParserContext): Json {
  const interfaces: Json[] = [];
  for (const line of deviceLines(raw)) {
    const t = line.trim().split(/\s+/);
    if (t.length < 3 || !/^(Ethernet|Eth|Vlan|Loopback|Lo|Port-channel|Po|mgmt)\S+/i.test(t[0])) continue;
    const state = t.slice(2).join(" ").toLowerCase();
    const adminStatus = /admin-?down|down/.test(state) && !/admin-?up/.test(state) ? "down" : "up";
    const operStatus = /protocol-?up|link-?up|up/.test(state) ? "up" : "down";
    const entry = jobj();
    entry.setStr("name", canonNxosIf(t[0]));
    entry.setStrOrNull("ipAddress", IPX.test(t[1]) ? t[1] : null);
    entry.setStr("method", "manual");
    entry.setStr("status", state);
    entry.setStr("adminStatus", adminStatus);
    entry.setStr("operStatus", operStatus);
    interfaces.push(entry);
  }
  return kindList("ios.ipInterfaces", "interfaces", interfaces);
}

/**
 * `show ip route` → the `ios.ipRoute` shape. NX-OS prints the prefix on its own
 * line followed by indented `*via …` next-hops; a compact single-line form
 * appears on some builds and is handled too.
 */
export function parseNxosRoutes(raw: string, ctx: ParserContext): Json {
  const routes: Json[] = [];
  let vrf = "";
  let pending = "";
  let pendingProto = "static";
  let pendingAd = 1;
  let pendingMetric = 0;

  const headRe = new RegExp(`^(${IP_SOURCE}\\/\\d{1,2}),.*$`);
  const viaRe = new RegExp(`^\\*?via\\s+(${IP_SOURCE})(?:,\\s*([^,]+))?(?:,\\s*\\[(\\d+)\\/(\\d+)\\])?.*$`, "i");
  const compactRe = new RegExp(
    `^([A-Z])\\S*\\s+(${IP_SOURCE}\\/\\d{1,2}).*?(?:directly connected,\\s*(\\S+)|via\\s+(${IP_SOURCE}).*?,\\s*(\\S+))`,
    "i",
  );

  for (const line of deviceLines(raw)) {
    const t = line.trim();
    const vrfM = t.match(/VRF\s+"?([^"\s]+)"?/i);
    if (vrfM !== null) {
      vrf = vrfM[1] === "default" ? "" : vrfM[1];
      continue;
    }

    const head = t.match(headRe);
    if (head !== null) {
      pending = head[1];
      pendingProto = /direct|attached/i.test(t)
        ? "connected"
        : /ospf/i.test(t)
          ? "ospf"
          : /bgp/i.test(t)
            ? "bgp"
            : "static";
      pendingAd = pendingProto === "connected" ? 0 : pendingProto === "ospf" ? 110 : 1;
      pendingMetric = 0;
      continue;
    }

    const via = t.match(viaRe);
    if (via !== null && pending !== "") {
      const viaIface = group(via, 2);
      const iface = viaIface === "" ? "" : canonNxosIf(viaIface.trim());
      const route = jobj();
      route.setStr("prefix", pending);
      route.setStr("protocol", /local/i.test(t) ? "local" : /direct/i.test(t) ? "connected" : pendingProto);
      route.setNum("adminDistance", hasGroup(via, 3) ? Number(group(via, 3)) : pendingAd);
      route.setNum("metric", hasGroup(via, 4) ? Number(group(via, 4)) : pendingMetric);
      if (iface !== "") route.setStr("outgoingInterface", iface);
      if (!/direct|local/i.test(t)) route.setStr("nextHopIp", group(via, 1));
      routes.push(route);
      continue;
    }

    // The compact form some builds print: `C 10.0.0.0/24 is directly
    // connected, Ethernet1/1`.
    const compact = t.match(compactRe);
    if (compact === null) continue;
    const code = group(compact, 1).toUpperCase();
    const protocol =
      code === "C" ? "connected" : code === "L" ? "local" : code === "O" ? "ospf" : code === "B" ? "bgp" : "static";
    const iface = hasGroup(compact, 3) ? group(compact, 3) : group(compact, 5);
    const route = jobj();
    route.setStr("prefix", group(compact, 2));
    route.setStr("protocol", protocol);
    route.setNum("adminDistance", protocol === "connected" || protocol === "local" ? 0 : 1);
    route.setNum("metric", 0);
    if (hasGroup(compact, 4)) route.setStr("nextHopIp", group(compact, 4));
    if (iface !== "") route.setStr("outgoingInterface", canonNxosIf(iface));
    routes.push(route);
  }

  const node = kindObject("ios.ipRoute");
  node.setOptStr("vrf", vrf);
  const list = jarr();
  for (const route of routes) list.push(route);
  node.set("routes", list);
  return node;
}
