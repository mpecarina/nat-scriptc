/**
 * Structured parsers for SONiC `show` commands.
 *
 * Downstream consumers read `--parse` output instead of re-parsing text, so
 * each parser returns a neutral, self-describing shape:
 *
 *   show version          -> { kind: "sonic.version",          fields: {…} }
 *   show interface status -> { kind: "sonic.interfaceStatus",  interfaces: […] }
 *   show ip interfaces    -> { kind: "sonic.ipInterfaces",     interfaces: […] }
 *   show ip route         -> { kind: "sonic.ipRoute",          routes: […] }
 *   show lldp table       -> { kind: "sonic.lldpTable",        neighbors: […] }
 *   show arp              -> { kind: "sonic.arp",              neighbors: […] }
 *
 * A field with no value is omitted rather than emitted as null, so a consumer
 * can tell "the device did not report this" from "the device reported none".
 */

import { Json, jarr, jobj, jstr } from "./json.ts";
import { ParserContext } from "./models.ts";
import {
  boolFieldFrom,
  dashRowIndex,
  deviceLines,
  findToken,
  firstToken,
  kindList,
  kindObject,
  kvPairs,
  numFieldFrom,
  splitTableRow,
  toNumOrNull,
} from "./parse-util.ts";
import { group, hasGroup } from "./text.ts";

const CIDR = /^\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}$/;

// Purely internal interfaces are skipped. The pattern is anchored so "lo" does
// not match "Loopback1", which is a real SONiC loopback worth keeping.
const SKIP_IFACE = /^(docker\d+|lo|veth\w*|tun\w*|dummy\w*|Bridge\w*)$/i;

/** `25G` / `25000` → Mbps, or null when the token is not a speed. */
function speedToMbps(speed: string): number | null {
  const m = speed.trim().match(/^(\d+(?:\.\d+)?)\s*([gmGM])?/);
  if (m === null) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value)) return null;
  const captured = group(m, 2);
  const unit = (captured === "" ? "g" : captured).toLowerCase();
  return unit === "g" ? Math.round(value * 1000) : Math.round(value);
}

/** `show version` → identity fields (a `key: value` transcript). */
export function parseSonicVersion(raw: string, ctx: ParserContext): Json {
  const fields = jobj();
  for (const line of deviceLines(raw)) {
    const m = line.match(/^([A-Za-z][A-Za-z0-9 ._/-]+?)\s*:\s*(.+)$/);
    if (m !== null) fields.setStr(m[1].trim(), m[2].trim());
  }
  return kindObject("sonic.version").set("fields", fields);
}

/**
 * `show interface status` → per-port status. Two SONiC CLI variants exist:
 *   - management framework: `Name Description Oper Reason AutoNeg Speed MTU Alt`
 *   - click `show interfaces status`: `Interface Lanes Speed MTU FEC Alias Vlan
 *     Oper Admin Type [Asym PFC]` (no Description; Speed is like "25G").
 * The variant is read off the header row so neither leaks another variant's
 * columns into the wrong field (Lanes misread as a bogus description, say).
 */
export function parseSonicInterfaceStatus(raw: string, ctx: ParserContext): Json {
  const lines = deviceLines(raw);
  const dash = dashRowIndex(lines);
  if (dash < 0) return kindList("sonic.interfaceStatus", "interfaces", []);

  // The header is the pre-data row carrying both Speed and MTU; the click form
  // additionally carries Lanes/Alias/FEC, which the mgmt-framework form lacks.
  let headerLine = "";
  for (const line of lines) {
    if (/\bMTU\b/i.test(line) && /\bSpeed\b/i.test(line)) {
      headerLine = line;
      break;
    }
  }
  const clickForm = /\b(lanes|fec|alias)\b/i.test(headerLine);

  const interfaces: Json[] = [];
  for (const line of lines.slice(dash + 1)) {
    const t = line.trim().split(/\s+/);
    if (t.length < 2 || !/^(Ethernet|PortChannel|Vlan|Eth|Loopback|Management)\d/i.test(t[0])) continue;
    const operIdx = findToken(t, /^(up|down)$/i, 1);
    const operStatus = operIdx >= 0 ? t[operIdx].toLowerCase() : "";

    const entry = jobj();
    entry.setStr("name", t[0]);
    if (clickForm) {
      // No description column; Speed is a "25G"/"10G" token, the alias is
      // "Eth<n>/<n>", and MTU is the four-digit column.
      entry.setOptStr("operStatus", operStatus === "" ? null : operStatus);
      const speedTok = firstToken(t, /^\d+(?:\.\d+)?[gmGM]$/);
      const alias = firstToken(t, /^Eth\d+\/\d+$/i);
      let mtu = -1;
      for (const token of t) {
        const value = Number(token);
        if (Number.isInteger(value) && value >= 1000) {
          mtu = value;
          break;
        }
      }
      if (speedTok !== "") entry.setOptNum("speedMbps", speedToMbps(speedTok));
      if (mtu > 0) entry.setNum("mtu", mtu);
      if (alias !== "") entry.setStr("alternateName", alias);
      interfaces.push(entry);
      continue;
    }

    // Management-framework form: the description (which may be blank) is
    // everything between the name and the oper token; speed is already Mbps.
    const description = operIdx > 1 ? t.slice(1, operIdx).join(" ") : "";
    const nums: number[] = [];
    for (const token of t) {
      if (/^\d+$/.test(token)) nums.push(Number(token));
    }
    const alt = t[t.length - 1];
    if (description !== "") entry.setStr("description", description);
    entry.setOptStr("operStatus", operStatus === "" ? null : operStatus);
    if (nums.length > 0) entry.setNum("speedMbps", nums[0]);
    if (nums.length > 1) entry.setNum("mtu", nums[1]);
    if (/^Eth\d+\/\d+$/i.test(alt)) entry.setStr("alternateName", alt);
    interfaces.push(entry);
  }
  return kindList("sonic.interfaceStatus", "interfaces", interfaces);
}

/**
 * `show ip interfaces` → interface → addresses, admin/oper state and VRF.
 * Enterprise SONiC prints a VRF (Master) column between the address and the
 * Admin/Oper token; it is blank for default-VRF interfaces. Columns are read by
 * pattern and relative position, not fixed offset, because that column is often
 * empty.
 */
export function parseSonicIpInterfaces(raw: string, ctx: ParserContext): Json {
  const lines = deviceLines(raw);
  const dash = dashRowIndex(lines);
  if (dash < 0) return kindList("sonic.ipInterfaces", "interfaces", []);

  const interfaces: Json[] = [];
  for (const line of lines.slice(dash + 1)) {
    const t = line.trim().split(/\s+/);
    if (t.length === 0 || t[0] === "") continue;
    const name = t[0];
    if (SKIP_IFACE.test(name)) continue;
    const addrIdx = findToken(t, CIDR, 0);
    if (addrIdx < 0) continue;
    const operIdx = findToken(t, /^(up|down)\/(up|down)$/i, 0);
    const states = (operIdx >= 0 ? t[operIdx] : "/").split("/");
    const admin = states.length > 0 ? states[0] : "";
    const oper = states.length > 1 ? states[1] : "";

    // The VRF (Master) column sits between the address and the Admin/Oper
    // token. When present it names the tenant VRF; "-" or absence means default.
    let vrf = "";
    if (operIdx > addrIdx + 1) {
      for (const token of t.slice(addrIdx + 1, operIdx)) {
        if (token !== "" && token !== "-") {
          vrf = token;
          break;
        }
      }
    }

    const entry = jobj();
    entry.setStr("name", name);
    entry.set("addresses", jarr().push(jstr(t[addrIdx])));
    entry.setOptStr("adminStatus", admin === "" ? null : admin.toLowerCase());
    entry.setOptStr("operStatus", oper === "" ? null : oper.toLowerCase());
    if (vrf !== "" && vrf.toLowerCase() !== "default") entry.setStr("vrf", vrf);
    interfaces.push(entry);
  }
  return kindList("sonic.ipInterfaces", "interfaces", interfaces);
}

/**
 * `show ip route` (FRR) → normalized routes. The common single-line forms:
 *   C>* 10.0.0.0/24 is directly connected, Ethernet0, 00:01:09
 *   S>* 10.2.2.2/32 [1/0] via 10.255.0.2, Ethernet0, weight 1, 00:01:09
 *   K>* 0.0.0.0/0 [0/202] via 192.168.122.1, eth0, 00:02:35
 * The leading FRR code is preserved as `protocol`; consumers normalize it.
 */
export function parseSonicRoutes(raw: string, ctx: ParserContext): Json {
  const routes: Json[] = [];
  for (const line of deviceLines(raw)) {
    if (/^Codes:/.test(line) || (/^\s/.test(line) && !/\d+\.\d+\.\d+\.\d+/.test(line))) continue;
    const m = line.trim().match(/^([A-Za-z])[A-Za-z]*[>* ]*\s+(\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2})\s+(.*)$/);
    if (m === null) continue;
    const rest = m[3];

    const route = jobj();
    route.setStr("prefix", m[2]);
    route.setStr("protocol", m[1].toUpperCase());
    route.setNum("adminDistance", 0);
    route.setNum("metric", 0);

    // vtysh renders "[ad/metric]"; the mgmt-framework tabular form renders a
    // bare "ad/metric" column (e.g. "200/0").
    let adm = rest.match(/\[(\d+)\/(\d+)\]/);
    if (adm === null) adm = rest.match(/(?:^|\s)(\d+)\/(\d+)(?=\s|$)/);
    if (adm !== null) {
      route.setNum("adminDistance", Number(adm[1]));
      route.setNum("metric", Number(adm[2]));
    }

    // Next hop: IPv4 only. IPv6 link-local next hops (the BGP-unnumbered fabric
    // underlay) are deliberately dropped so consumers fall back to the outgoing
    // interface plus the LLDP adjacency to resolve the underlay hop.
    const via = rest.match(/via\s+(\d{1,3}(?:\.\d{1,3}){3})\b/);
    if (via !== null) route.setStr("nextHopIp", via[1]);

    const conn = rest.match(/directly connected,\s*([A-Za-z0-9._/-]+)/);
    const viaIf = rest.match(/via\s+\d{1,3}(?:\.\d{1,3}){3},\s*([A-Za-z0-9._/-]+)/);
    const tabIf = rest.match(
      /\b((?:Ethernet|Eth|PortChannel|Po|Vlan|Loopback|Management|Bridge)\d[\w./-]*|eth\d+)\b/,
    );
    let iface = "";
    if (conn !== null) iface = conn[1];
    else if (viaIf !== null) iface = viaIf[1];
    else if (tabIf !== null) iface = tabIf[1];
    if (iface !== "") route.setStr("outgoingInterface", iface);
    routes.push(route);
  }
  return kindList("sonic.ipRoute", "routes", routes);
}

/**
 * `show lldp table` → neighbour rows. Columns:
 *   LocalPort RemoteDevice RemotePortID Capability RemotePortDescr
 */
export function parseSonicLldpTable(raw: string, ctx: ParserContext): Json {
  const lines = deviceLines(raw);
  const dash = dashRowIndex(lines);
  if (dash < 0) return kindList("sonic.lldpTable", "neighbors", []);
  const neighbors: Json[] = [];
  for (const line of lines.slice(dash + 1)) {
    if (/^Total entries/i.test(line.trim())) break;
    const t = line.trim().split(/\s+/);
    if (t.length < 3 || !/^(Ethernet|Eth|PortChannel)/i.test(t[0])) continue;
    const entry = jobj();
    entry.setStr("localPort", t[0]);
    entry.setStr("remoteDevice", t[1]);
    entry.setStr("remotePortId", t[2]);
    entry.setStr("capability", t.length > 3 ? t[3] : "");
    neighbors.push(entry);
  }
  return kindList("sonic.lldpTable", "neighbors", neighbors);
}

/** `show arp` → neighbour rows. Columns: Address MacAddress Iface [Vlan] Status */
export function parseSonicArp(raw: string, ctx: ParserContext): Json {
  const lines = deviceLines(raw);
  const dash = dashRowIndex(lines);
  if (dash < 0) return kindList("sonic.arp", "neighbors", []);
  const neighbors: Json[] = [];
  for (const line of lines.slice(dash + 1)) {
    if (/^Total number/i.test(line.trim())) break;
    const t = line.trim().split(/\s+/);
    if (t.length < 3 || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(t[0])) continue;
    // `show arp`    → Address MacAddress Iface [Vlan] Status
    // `show ip arp` → Address HWaddr Interface Egress Type Action
    const type = firstToken(t, /^(Static|Dynamic|Remote|Permanent)$/i);
    const entry = jobj();
    entry.setStr("ip", t[0]);
    entry.setStr("mac", t[1]);
    entry.setStr("iface", t[2]);
    if (type !== "") entry.setStr("type", type);
    entry.setStr("status", t[t.length - 1]);
    neighbors.push(entry);
  }
  return kindList("sonic.arp", "neighbors", neighbors);
}

/** The address family implied by a `show bgp <afi> <safi> summary` command. */
function bgpAddressFamily(command: string): string {
  if (/l2vpn\s+evpn/i.test(command)) return "l2vpn-evpn";
  if (/ipv4\s+unicast/i.test(command)) return "ipv4-unicast";
  if (/ipv6\s+unicast/i.test(command)) return "ipv6-unicast";
  return "";
}

/**
 * `show bgp ipv4 unicast summary` / `show bgp l2vpn evpn summary` → the
 * neighbour table. sonic-cli wraps each row across two physical lines (the
 * trailing `State/PfxRcd` column drops onto the next), so the neighbour region
 * is flattened to a token stream and chunked nine per row:
 *   Neighbor V AS MsgRcvd MsgSent InQ OutQ Up/Down State/PfxRcd
 * `State/PfxRcd` is numeric when the session is Established (prefixes received)
 * and a state word (Idle/Active/Connect/OpenSent…) otherwise.
 */
export function parseSonicBgpSummary(raw: string, ctx: ParserContext): Json {
  const lines = deviceLines(raw);
  let routerId = "";
  let localAs: number | null = null;
  let vrf = "";
  for (const line of lines) {
    const m = line.match(/BGP router identifier (\S+), local AS number (\d+)(?:\s+VRF\s+(\S+))?/);
    if (m === null) continue;
    routerId = m[1];
    localAs = Number(m[2]);
    vrf = hasGroup(m, 3) ? group(m, 3) : "default";
    break;
  }

  let headIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*Neighbor\s+V\s+AS\b/.test(lines[i])) {
      headIdx = i;
      break;
    }
  }

  const neighbors: Json[] = [];
  let totalNeighbors: number | null = null;
  let establishedNeighbors: number | null = null;
  if (headIdx >= 0) {
    const body: string[] = [];
    for (const line of lines.slice(headIdx + 1)) {
      const est = line.match(/Total number of neighbors established\s+(\d+)/i);
      if (est !== null) {
        establishedNeighbors = Number(est[1]);
        break;
      }
      const tot = line.match(/Total number of neighbors\s+(\d+)/i);
      if (tot !== null) {
        totalNeighbors = Number(tot[1]);
        continue;
      }
      if (/State\/PfxRcd/.test(line)) continue; // the wrapped header tail
      body.push(line);
    }
    const joined = body.join(" ").trim();
    const toks: string[] = [];
    if (joined !== "") {
      for (const token of joined.split(/\s+/)) {
        if (token !== "") toks.push(token);
      }
    }
    for (let i = 0; i + 9 <= toks.length; i += 9) {
      const v = toks[i + 1];
      const as = toks[i + 2];
      // Alignment guard: V and AS must be numeric or the columns have drifted.
      if (!/^\d+$/.test(v) || !/^\d+$/.test(as)) break;
      const statePfx = toks[i + 8];
      const established = /^\d+$/.test(statePfx);
      const entry = jobj();
      entry.setStr("neighbor", toks[i]);
      entry.setOptNum("version", toNumOrNull(v));
      entry.setOptNum("remoteAs", toNumOrNull(as));
      entry.setOptNum("msgRcvd", toNumOrNull(toks[i + 3]));
      entry.setOptNum("msgSent", toNumOrNull(toks[i + 4]));
      entry.setOptNum("inQ", toNumOrNull(toks[i + 5]));
      entry.setOptNum("outQ", toNumOrNull(toks[i + 6]));
      entry.setStr("upDown", toks[i + 7]);
      entry.setStr("state", established ? "Established" : statePfx);
      if (established) entry.setOptNum("prefixesReceived", toNumOrNull(statePfx));
      neighbors.push(entry);
    }
  }

  const node = kindObject("sonic.bgpSummary");
  node.setOptStr("addressFamily", bgpAddressFamily(ctx.command));
  node.setOptStr("routerId", routerId);
  node.setOptNum("localAs", localAs);
  node.setOptStr("vrf", vrf);
  const list = jarr();
  for (const entry of neighbors) list.push(entry);
  node.set("neighbors", list);
  node.setOptNum("totalNeighbors", totalNeighbors);
  node.setOptNum("establishedNeighbors", establishedNeighbors);
  return node;
}

/** `show evpn` → global EVPN state (a `key: value` transcript). */
export function parseSonicEvpn(raw: string, ctx: ParserContext): Json {
  const kv = kvPairs(deviceLines(raw));
  const node = kindObject("sonic.evpn");
  node.setOptNum("l2VniCount", numFieldFrom(kv, "L2 VNIs"));
  node.setOptNum("l3VniCount", numFieldFrom(kv, "L3 VNIs"));
  node.setOptBool("advertiseGatewayMacIp", boolFieldFrom(kv, "Advertise gateway mac-ip"));
  node.setOptBool("advertiseSviMacIp", boolFieldFrom(kv, "Advertise svi mac-ip"));
  node.setOptBool("advertiseSviMac", boolFieldFrom(kv, "Advertise svi mac"));
  node.setOptNum("totalIpv4Neighbors", numFieldFrom(kv, "Total IPv4 neighbors"));
  node.setOptNum("totalIpv6Neighbors", numFieldFrom(kv, "Total IPv6 neighbors"));
  node.set("fields", kv);
  return node;
}

/** `show evpn vni <vni>` → per-VNI detail (a `key: value` transcript). */
export function parseSonicEvpnVni(raw: string, ctx: ParserContext): Json {
  const lines = deviceLines(raw);
  const kv = kvPairs(lines);
  let hasRemoteVteps = true;
  for (const line of lines) {
    if (/No remote VTEPs known/i.test(line)) {
      hasRemoteVteps = false;
      break;
    }
  }
  const node = kindObject("sonic.evpnVni");
  node.setOptNum("vni", numFieldFrom(kv, "VNI"));
  node.setOptStr("type", kv.str("Type", ""));
  node.setOptStr("tenantVrf", kv.str("Tenant VRF", ""));
  node.setOptStr("clientState", kv.str("Client State", ""));
  node.setOptStr("vxlanInterface", kv.str("VxLAN interface", ""));
  node.setOptStr("sviInterface", kv.str("SVI interface", ""));
  node.setOptStr("localVtepIp", kv.str("Local VTEP IP", ""));
  node.setOptStr("mcastGroup", kv.str("Mcast group", ""));
  node.setBool("hasRemoteVteps", hasRemoteVteps);
  node.setOptNum("macCount", numFieldFrom(kv, "Number of MACs (local and remote) known for this VNI"));
  node.setOptNum(
    "arpCount",
    numFieldFrom(kv, "Number of ARPs (IPv4 and IPv6, local and remote) known for this VNI"),
  );
  node.setOptBool("advertiseGwMacIp", boolFieldFrom(kv, "Advertise-gw-macip"));
  node.setOptBool("advertiseSviMacIp", boolFieldFrom(kv, "Advertise-svi-macip"));
  node.set("fields", kv);
  return node;
}

/**
 * `show vxlan interface` → VTEP identity and source. Two CLI variants exist:
 * the management-framework form prints one aligned `Key : Value` per line
 * ("VTEP Source IP", "EVPN NVO Name", "Source Interface"); the vtysh/FRR form
 * packs several comma-separated pairs per line with short keys ("VTEP Name :
 * vtep1, SIP : 10.0.0.2"). Both are read here so the VTEP source IP — the
 * identity overlay tunnels are keyed on — is always found.
 */
export function parseSonicVxlanInterface(raw: string, ctx: ParserContext): Json {
  const kv = jobj();
  for (const line of deviceLines(raw)) {
    // Split comma-packed "Key : Value, Key : Value" fragments (vtysh form);
    // single-pair lines (mgmt-framework form) pass through as one fragment.
    for (const frag of line.split(",")) {
      const m = frag.match(/^\s*([A-Za-z][A-Za-z0-9 .()/_-]*?)\s*:\s*(.*\S)\s*$/);
      if (m !== null) kv.setStr(m[1].trim(), m[2].trim());
    }
  }
  const node = kindObject("sonic.vxlanInterface");
  node.setOptStr("vtepName", kv.str("VTEP Name", ""));
  node.setOptStr("sourceIp", kv.str("VTEP Source IP", "") !== "" ? kv.str("VTEP Source IP", "") : kv.str("SIP", ""));
  node.setOptStr(
    "evpnNvoName",
    kv.str("EVPN NVO Name", "") !== "" ? kv.str("EVPN NVO Name", "") : kv.str("NVO Name", ""),
  );
  node.setOptStr("evpnVtep", kv.str("EVPN VTEP", "") !== "" ? kv.str("EVPN VTEP", "") : kv.str("VTEP", ""));
  node.setOptStr(
    "sourceInterface",
    kv.str("Source Interface", "") !== "" ? kv.str("Source Interface", "") : kv.str("Source interface", ""),
  );
  node.setOptStr("qosMode", kv.str("QoS Mode", ""));
  node.set("fields", kv);
  return node;
}

/** `show vxlan vlanvnimap` → VLAN→VNI (L2 VNI) mappings. */
export function parseSonicVxlanVlanVniMap(raw: string, ctx: ParserContext): Json {
  const mappings: Json[] = [];
  let totalCount: number | null = null;
  for (const line of deviceLines(raw)) {
    const tc = line.match(/Total count\s*:\s*(\d+)/i);
    if (tc !== null) {
      totalCount = Number(tc[1]);
      continue;
    }
    // Plain aligned columns ("Vlan10   10010") and the tabulate grid form
    // ("| Vlan10 | 10010 |") both reduce to [name, vni] here.
    const cells = splitTableRow(line);
    const name = cells.length > 0 ? cells[0] : "";
    const vni = cells.length > 1 ? cells[1] : "";
    const m = name.match(/^Vlan(\d+)$/i);
    if (m === null || !/^\d+$/.test(vni)) continue;
    const entry = jobj();
    entry.setStr("vlan", `Vlan${m[1]}`);
    entry.setNum("vlanId", Number(m[1]));
    entry.setNum("vni", Number(vni));
    mappings.push(entry);
  }
  const node = kindList("sonic.vxlanVlanVniMap", "mappings", mappings);
  node.setOptNum("totalCount", totalCount);
  return node;
}

/** `show vxlan vrfvnimap` → VRF→VNI (L3 VNI) mappings. */
export function parseSonicVxlanVrfVniMap(raw: string, ctx: ParserContext): Json {
  const mappings: Json[] = [];
  let totalCount: number | null = null;
  for (const line of deviceLines(raw)) {
    const tc = line.match(/Total count\s*:\s*(\d+)/i);
    if (tc !== null) {
      totalCount = Number(tc[1]);
      continue;
    }
    const cells = splitTableRow(line);
    const vrf = cells.length > 0 ? cells[0] : "";
    const vni = cells.length > 1 ? cells[1] : "";
    if (vrf === "" || vrf === "VRF" || !/^\d+$/.test(vni)) continue;
    const entry = jobj();
    entry.setStr("vrf", vrf);
    entry.setNum("vni", Number(vni));
    mappings.push(entry);
  }
  const node = kindList("sonic.vxlanVrfVniMap", "mappings", mappings);
  node.setOptNum("totalCount", totalCount);
  return node;
}

/** `show vxlan tunnel` → EVPN VTEP tunnels. Rows anchor on the SIP/DIP pair. */
export function parseSonicVxlanTunnel(raw: string, ctx: ParserContext): Json {
  const tunnels: Json[] = [];
  const ip = "\\d{1,3}(?:\\.\\d{1,3}){3}";
  const re = new RegExp(`^\\s*(\\S+)\\s+(${ip})\\s+(${ip})\\s+(\\S+)\\s+(\\S+)\\s+(\\S+)\\s+(\\S+)\\s*$`);
  for (const line of deviceLines(raw)) {
    const m = line.match(re);
    if (m === null) continue;
    const entry = jobj();
    entry.setStr("name", m[1]);
    entry.setStr("srcIp", m[2]);
    entry.setStr("dstIp", m[3]);
    entry.setStr("source", m[4]);
    entry.setStr("group", m[5]);
    entry.setStr("dvni", m[6]);
    entry.setStr("operStatus", m[7]);
    tunnels.push(entry);
  }
  return kindList("sonic.vxlanTunnel", "tunnels", tunnels);
}

/**
 * `show ip vrf` → VRF → member L3 interfaces. The VRF name appears only on the
 * first row of each group; indented rows are continuation interfaces.
 */
export function parseSonicIpVrf(raw: string, ctx: ParserContext): Json {
  const lines = deviceLines(raw);
  const dash = dashRowIndex(lines);
  const vrfs: Json[] = [];
  let current: Json | null = null;
  let currentIfaces: Json | null = null;
  for (const line of lines.slice(dash >= 0 ? dash + 1 : 0)) {
    if (/^\s*VRF-NAME\b/i.test(line)) continue;
    const isContinuation = /^\s/.test(line);
    const toks: string[] = [];
    for (const token of line.trim().split(/\s+/)) {
      if (token !== "") toks.push(token);
    }
    if (toks.length === 0) continue;
    if (isContinuation && current !== null && currentIfaces !== null) {
      currentIfaces.push(jstr(toks[0]));
      continue;
    }
    const entry = jobj();
    entry.setStr("name", toks[0]);
    const ifaces = jarr();
    entry.set("interfaces", ifaces);
    if (toks.length > 1) ifaces.push(jstr(toks[1]));
    vrfs.push(entry);
    current = entry;
    currentIfaces = ifaces;
  }
  return kindList("sonic.ipVrf", "vrfs", vrfs);
}

function vlanTagging(code: string): string {
  if (/^a$/i.test(code)) return "access";
  if (/^t$/i.test(code)) return "tagged";
  return "";
}

/**
 * `show vlan` → VLANs with their member ports. `Q` marks port tagging (A =
 * access/untagged, T = tagged). A VLAN with no member leaves the middle columns
 * blank, so the row is decoded by anchoring on the Autostate column.
 */
export function parseSonicVlan(raw: string, ctx: ParserContext): Json {
  const vlans: Json[] = [];
  let current: Json | null = null;
  let currentPorts: Json | null = null;
  for (const line of deviceLines(raw)) {
    if (/^Q:\s/.test(line) || /^\s*NUM\s+Status\b/i.test(line)) continue;
    const toks: string[] = [];
    for (const token of line.trim().split(/\s+/)) {
      if (token !== "") toks.push(token);
    }
    if (toks.length === 0) continue;

    if (/^\d+$/.test(toks[0])) {
      const entry = jobj();
      entry.setNum("vlanId", Number(toks[0]));
      entry.setStr("status", toks.length > 1 ? toks[1] : "");
      const ports = jarr();
      entry.set("ports", ports);
      vlans.push(entry);
      current = entry;
      currentPorts = ports;

      const rest = toks.slice(2);
      const asIdx = findToken(rest, /^(Enable|Disable)$/i, 0);
      if (asIdx >= 0) {
        entry.setStr("autostate", rest[asIdx]);
        if (asIdx + 1 < rest.length && /^(Yes|No)$/i.test(rest[asIdx + 1])) {
          entry.setStr("dynamic", rest[asIdx + 1]);
        }
      }
      const mid = rest.slice(0, asIdx >= 0 ? asIdx : rest.length);
      if (mid.length > 0) {
        const tagging = vlanTagging(mid[0]);
        const ports2 = tagging !== "" ? mid.slice(1) : mid;
        for (const port of ports2) {
          ports.push(jobj().setStr("name", port).setOptStr("tagging", tagging === "" ? null : tagging));
        }
      }
      continue;
    }

    if (current === null || currentPorts === null) continue;
    const tagging = vlanTagging(toks[0]);
    const ports = tagging !== "" ? toks.slice(1) : toks;
    for (const port of ports) {
      if (!/^(Ethernet|PortChannel|Eth)/i.test(port)) continue;
      currentPorts.push(jobj().setStr("name", port).setOptStr("tagging", tagging === "" ? null : tagging));
    }
  }
  return kindList("sonic.vlan", "vlans", vlans);
}

/** `show mac address-table` → learned MAC entries (VLAN / MAC / TYPE / port). */
export function parseSonicMacAddressTable(raw: string, ctx: ParserContext): Json {
  const entries: Json[] = [];
  const macRe = /^\s*(\d+)\s+([0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5})\s+(\S+)\s+(\S+)\s*$/;
  for (const line of deviceLines(raw)) {
    if (/^[\s-]+$/.test(line) || /MAC-ADDRESS/i.test(line)) continue;
    if (/^\s*(Total|Dynamic|Static|MAC Entries)/i.test(line)) continue;
    const m = line.match(macRe);
    if (m === null) continue;
    const entry = jobj();
    entry.setNum("vlan", Number(m[1]));
    entry.setStr("mac", m[2].toLowerCase());
    entry.setStr("type", m[3]);
    entry.setStr("interface", m[4]);
    entries.push(entry);
  }
  return kindList("sonic.macAddressTable", "entries", entries);
}
