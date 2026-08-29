/**
 * src/drivers.ts — output parsers scoped by driver / target OS.
 *
 * With `--parse`, each command's cleaned output becomes a structured object.
 * The same logical command prints differently across platforms, so parsers are
 * organized by *driver* (the host's target OS). A host's driver comes from
 * `--driver`, the ssh-config `#nat-driver` keyword, or falls back to `generic`.
 *
 * A table is a list of driver scopes, each a list of command rules. Command
 * keys may use `*` as a glob (`"ls -l*"` matches `ls -lh /`) and are matched in
 * priority order: exact → glob → the bare `*` wildcard, and within each step
 * the host's own driver before the `*` driver. Custom rules always win over the
 * built-ins for the same driver and command.
 */

import { Json, jobj, jstr } from "./json.ts";
import { ParserContext } from "./models.ts";
import {
  parseIpAddr,
  parseIpRoute,
  parseKeyValue,
  parseLs,
  parseTable,
  parseUnixAuto,
  parseVyosInterfaces,
  parseVyosRoutes,
} from "./parsers-generic.ts";
import {
  parseEosIpInterfaceBrief,
  parseEosInterfacesStatus,
  parseEosLldpNeighbors,
  parseEosRoutes,
  parseEosVersion,
} from "./parsers-eos.ts";
import {
  parseIosCdpNeighbors,
  parseIosIpInterfaceBrief,
  parseIosRoutes,
  parseIosVersion,
} from "./parsers-ios.ts";
import { parseNxosIpInterfaceBrief, parseNxosRoutes, parseNxosVersion } from "./parsers-nxos.ts";
import {
  parseSonicArp,
  parseSonicBgpSummary,
  parseSonicEvpn,
  parseSonicEvpnVni,
  parseSonicInterfaceStatus,
  parseSonicIpInterfaces,
  parseSonicIpVrf,
  parseSonicLldpTable,
  parseSonicMacAddressTable,
  parseSonicRoutes,
  parseSonicVersion,
  parseSonicVlan,
  parseSonicVxlanInterface,
  parseSonicVxlanTunnel,
  parseSonicVxlanVlanVniMap,
  parseSonicVxlanVrfVniMap,
} from "./parsers-sonic.ts";
import { globToRegExp, normalizeSpace } from "./text.ts";

export const DEFAULT_DRIVER = "generic";
export const WILDCARD = "*";

/** A parser: cleaned output plus its context, in; a JSON tree, out. */
export type ParserFn = (raw: string, ctx: ParserContext) => Json;

/** One command key and the parser it selects. */
export class ParserRule {
  key: string;
  fn: ParserFn;

  constructor(key: string, fn: ParserFn) {
    this.key = key;
    this.fn = fn;
  }
}

/** Every rule registered for one driver. */
export class DriverScope {
  driver: string;
  rules: ParserRule[];

  constructor(driver: string) {
    this.driver = driver;
    this.rules = [];
  }

  /** Register a rule, replacing any rule already using that key. */
  add(key: string, fn: ParserFn): DriverScope {
    for (const rule of this.rules) {
      if (rule.key === key) {
        rule.fn = fn;
        return this;
      }
    }
    this.rules.push(new ParserRule(key, fn));
    return this;
  }

  exact(command: string): ParserFn | null {
    for (const rule of this.rules) {
      if (rule.key === command) return rule.fn;
    }
    return null;
  }

  glob(normalized: string): ParserFn | null {
    for (const rule of this.rules) {
      if (rule.key === WILDCARD || !rule.key.includes(WILDCARD)) continue;
      if (globToRegExp(normalizeSpace(rule.key)).test(normalized)) return rule.fn;
    }
    return null;
  }

  wildcard(): ParserFn | null {
    return this.exact(WILDCARD);
  }
}

/** A complete parser table: the built-ins, or a loaded custom pack. */
export class ParserTable {
  scopes: DriverScope[];

  constructor() {
    this.scopes = [];
  }

  /** The scope for `driver`, created on first use. */
  scopeFor(driver: string): DriverScope {
    const name = driver.toLowerCase();
    for (const scope of this.scopes) {
      if (scope.driver === name) return scope;
    }
    const scope = new DriverScope(name);
    this.scopes.push(scope);
    return scope;
  }

  find(driver: string): DriverScope | null {
    const name = driver.toLowerCase();
    for (const scope of this.scopes) {
      if (scope.driver === name) return scope;
    }
    return null;
  }

  isEmpty(): boolean {
    return this.scopes.length === 0;
  }

  /** Copy `other`'s rules over this table's; later sources win. */
  merge(other: ParserTable): void {
    for (const scope of other.scopes) {
      const target = this.scopeFor(scope.driver);
      for (const rule of scope.rules) target.add(rule.key, rule.fn);
    }
  }

  /** Copy `source`'s rules into the `driver` scope. */
  extend(driver: string, source: DriverScope): void {
    const target = this.scopeFor(driver);
    for (const rule of source.rules) target.add(rule.key, rule.fn);
  }
}

/**
 * The parsers every Unix-like driver gets. The iproute2 reads are
 * twin-bearing: they are how a Linux host contributes its interfaces and its
 * routes. Those globs only fire when the verb is delivered literally, which is
 * why the `*` fallback sniffs the OUTPUT instead of the command.
 */
function commonUnixScope(): DriverScope {
  const scope = new DriverScope("");
  scope.add("ls -l*", parseLs);
  scope.add("ll*", parseLs);
  scope.add("df*", parseTable);
  scope.add("ps*", parseTable);
  scope.add("ip addr*", parseIpAddr);
  scope.add("ip -4 addr*", parseIpAddr);
  scope.add("ip -6 addr*", parseIpAddr);
  scope.add("ip a", parseIpAddr);
  scope.add("ip route*", parseIpRoute);
  scope.add("ip -4 route*", parseIpRoute);
  scope.add("ip -6 route*", parseIpRoute);
  scope.add("ip r", parseIpRoute);
  scope.add(WILDCARD, parseUnixAuto);
  return scope;
}

let builtinCache: ParserTable | null = null;

/** The built-in table, built once. */
export function builtinParsers(): ParserTable {
  if (builtinCache !== null) return builtinCache;
  const table = new ParserTable();
  const common = commonUnixScope();

  table.extend("generic", common);
  table.extend("linux", common);

  // SONiC ships structured parsers for the common `show` commands; anything
  // else falls back to the generic Unix / key-value parsers.
  table.extend("sonic", common);
  const sonic = table.scopeFor("sonic");
  sonic.add("show version", parseSonicVersion);
  sonic.add("show interface status", parseSonicInterfaceStatus);
  sonic.add("show ip interfaces", parseSonicIpInterfaces);
  sonic.add("show ip interfaces*", parseSonicIpInterfaces);
  sonic.add("show ip route", parseSonicRoutes);
  sonic.add("show ip route*", parseSonicRoutes);
  sonic.add("show lldp table", parseSonicLldpTable);
  sonic.add("show arp", parseSonicArp);
  sonic.add("show ip arp", parseSonicArp);
  sonic.add("show ip arp*", parseSonicArp);
  sonic.add("show bgp ipv4 unicast summary", parseSonicBgpSummary);
  sonic.add("show bgp ipv6 unicast summary", parseSonicBgpSummary);
  sonic.add("show bgp l2vpn evpn summary", parseSonicBgpSummary);
  sonic.add("show bgp * summary", parseSonicBgpSummary);
  sonic.add("show evpn", parseSonicEvpn);
  sonic.add("show evpn vni*", parseSonicEvpnVni);
  sonic.add("show vxlan interface", parseSonicVxlanInterface);
  sonic.add("show vxlan vlanvnimap", parseSonicVxlanVlanVniMap);
  sonic.add("show vxlan vlanvnimap*", parseSonicVxlanVlanVniMap);
  sonic.add("show vxlan vrfvnimap", parseSonicVxlanVrfVniMap);
  sonic.add("show vxlan vrfvnimap*", parseSonicVxlanVrfVniMap);
  sonic.add("show vxlan tunnel", parseSonicVxlanTunnel);
  sonic.add("show vxlan tunnel*", parseSonicVxlanTunnel);
  sonic.add("show ip vrf", parseSonicIpVrf);
  sonic.add("show ip vrf*", parseSonicIpVrf);
  sonic.add("show vlan", parseSonicVlan);
  sonic.add("show mac address-table", parseSonicMacAddressTable);
  sonic.add("show mac address-table*", parseSonicMacAddressTable);

  // VyOS is a Linux router: the Unix parsers apply, plus its op-mode shapes.
  // The op-mode wrapper forms are registered too, because nat's exec path runs
  // bare `show` verbs through `vyatta-op-cmd-wrapper`.
  table.extend("vyos", common);
  const vyos = table.scopeFor("vyos");
  vyos.add("show ip route", parseVyosRoutes);
  vyos.add("show ip route*", parseVyosRoutes);
  vyos.add("show interfaces", parseVyosInterfaces);
  vyos.add("show interfaces*", parseVyosInterfaces);
  vyos.add("*vyatta-op-cmd-wrapper show ip route*", parseVyosRoutes);
  vyos.add("*vyatta-op-cmd-wrapper show interfaces*", parseVyosInterfaces);

  const ios = table.scopeFor("ios");
  ios.add("show version", parseIosVersion);
  ios.add("show ip interface brief", parseIosIpInterfaceBrief);
  ios.add("show ip interface brief*", parseIosIpInterfaceBrief);
  ios.add("show ip route", parseIosRoutes);
  ios.add("show ip route*", parseIosRoutes);
  ios.add("show cdp neighbors detail", parseIosCdpNeighbors);
  ios.add("show cdp neighbors detail*", parseIosCdpNeighbors);
  ios.add(WILDCARD, parseKeyValue);

  // NX-OS reuses the IOS shapes where the outputs are compatible enough.
  const nxos = table.scopeFor("nxos");
  nxos.add("show version", parseNxosVersion);
  nxos.add("show ip interface brief", parseNxosIpInterfaceBrief);
  nxos.add("show ip interface brief*", parseNxosIpInterfaceBrief);
  nxos.add("show ip route", parseNxosRoutes);
  nxos.add("show ip route*", parseNxosRoutes);
  nxos.add("show cdp neighbors detail", parseIosCdpNeighbors);
  nxos.add("show cdp neighbors detail*", parseIosCdpNeighbors);
  nxos.add(WILDCARD, parseKeyValue);

  const eos = table.scopeFor("eos");
  eos.add("show version", parseEosVersion);
  eos.add("show interfaces status", parseEosInterfacesStatus);
  eos.add("show interfaces status*", parseEosInterfacesStatus);
  eos.add("show ip interface brief", parseEosIpInterfaceBrief);
  eos.add("show ip interface brief*", parseEosIpInterfaceBrief);
  eos.add("show ip route", parseEosRoutes);
  eos.add("show ip route*", parseEosRoutes);
  eos.add("show lldp neighbors", parseEosLldpNeighbors);
  eos.add("show lldp neighbors*", parseEosLldpNeighbors);
  eos.add(WILDCARD, parseKeyValue);

  // An unknown driver falls back to generic key/value extraction.
  table.scopeFor(WILDCARD).add(WILDCARD, parseKeyValue);

  builtinCache = table;
  return table;
}

/** Look one command up in a table, exact → glob → wildcard, driver then `*`. */
function lookup(table: ParserTable, driver: string, command: string): ParserFn | null {
  const normalized = normalizeSpace(command);
  const scopes: DriverScope[] = [];
  const own = table.find(driver);
  if (own !== null) scopes.push(own);
  const any = table.find(WILDCARD);
  if (any !== null) scopes.push(any);

  for (const scope of scopes) {
    const hit = scope.exact(command);
    if (hit !== null) return hit;
    const normalizedHit = scope.exact(normalized);
    if (normalizedHit !== null) return normalizedHit;
  }
  for (const scope of scopes) {
    const hit = scope.glob(normalized);
    if (hit !== null) return hit;
  }
  for (const scope of scopes) {
    const hit = scope.wildcard();
    if (hit !== null) return hit;
  }
  return null;
}

/** Custom parsers take priority over built-ins; both are tried by driver. */
export function resolveParser(driver: string, command: string, custom: ParserTable | null): ParserFn | null {
  const driverName = (driver === "" ? DEFAULT_DRIVER : driver).toLowerCase();
  if (custom !== null) {
    const hit = lookup(custom, driverName, command);
    if (hit !== null) return hit;
  }
  return lookup(builtinParsers(), driverName, command);
}

/**
 * Parse one command's output. Returns null when no parser matched. A parser
 * that throws is captured as `{ parseError }` — a bad parser must not fail the
 * run that collected good output.
 */
export function parseOutput(
  driver: string,
  command: string,
  raw: string,
  ctx: ParserContext,
  custom: ParserTable | null,
): Json | null {
  const parser = resolveParser(driver, command, custom);
  if (parser === null) return null;
  try {
    return parser(raw, ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : "parser failed";
    return jobj().set("parseError", jstr(message));
  }
}
