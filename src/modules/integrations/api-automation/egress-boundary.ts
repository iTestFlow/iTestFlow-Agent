import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

export type EgressTarget = {
  kind: "api" | "oauth" | "openapi" | "db";
  protocol: "http" | "https" | "tcp";
  host: string;
  port: number;
};

export type EgressBoundary = {
  targets: readonly EgressTarget[];
  /** Explicit deployment opt-in. Link-local and metadata ranges remain denied. */
  privateCidrs?: readonly string[];
};

export type AuthorizedEgress = { resolvedAddresses: string[] };

const hardDenied = new BlockList();
const privateRanges = new BlockList();
for (const [address, prefix, family] of [
  ["0.0.0.0", 8, "ipv4"], ["169.254.0.0", 16, "ipv4"], ["100.64.0.0", 10, "ipv4"],
  ["192.0.0.0", 24, "ipv4"], ["192.0.2.0", 24, "ipv4"], ["198.18.0.0", 15, "ipv4"],
  ["198.51.100.0", 24, "ipv4"], ["203.0.113.0", 24, "ipv4"],
  ["224.0.0.0", 4, "ipv4"], ["240.0.0.0", 4, "ipv4"],
  ["::", 128, "ipv6"], ["fe80::", 10, "ipv6"], ["ff00::", 8, "ipv6"], ["2001:db8::", 32, "ipv6"],
  ["fd00:ec2::254", 128, "ipv6"], ["100.100.100.200", 32, "ipv4"],
] as const) hardDenied.addSubnet(address, prefix, family);
for (const [address, prefix, family] of [
  ["10.0.0.0", 8, "ipv4"], ["172.16.0.0", 12, "ipv4"], ["192.168.0.0", 16, "ipv4"],
  ["127.0.0.0", 8, "ipv4"], ["::1", 128, "ipv6"], ["fc00::", 7, "ipv6"],
] as const) privateRanges.addSubnet(address, prefix, family);

/** Authorize exact snapshotted target, then resolve all addresses for socket pinning. */
export async function authorizeEgressTarget(boundary: EgressBoundary, target: EgressTarget): Promise<AuthorizedEgress> {
  const host = normalizeHost(target.host);
  if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535) throw new Error("Egress port is invalid.");
  if (!boundary.targets.some((entry) => entry.kind === target.kind && entry.protocol === target.protocol && entry.port === target.port && normalizeHost(entry.host) === host)) {
    throw new Error("Egress target is not in the run boundary.");
  }
  const privateAllowed = cidrList(boundary.privateCidrs ?? []);
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true, order: "verbatim" })).map((entry) => entry.address);
  if (addresses.length === 0) throw new Error("Egress target did not resolve.");
  for (const address of addresses) {
    const family = isIP(address) === 6 ? "ipv6" : isIP(address) === 4 ? "ipv4" : null;
    if (!family || hardDenied.check(address, family)) throw new Error("Egress address is denied.");
    if (privateRanges.check(address, family) && !privateAllowed.check(address, family)) throw new Error("Private egress address is not allowed.");
  }
  return { resolvedAddresses: addresses };
}

/** Adapter for API executor; every redirect and OAuth hop calls this again. */
export function createEgressAuthorizer(boundary: EgressBoundary) {
  return (url: URL, kind: "api" | "oauth" | "openapi") => {
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("HTTP egress URL is invalid.");
    return authorizeEgressTarget(boundary, {
      kind,
      protocol: url.protocol === "https:" ? "https" : "http",
      host: url.hostname,
      port: Number(url.port) || (url.protocol === "https:" ? 443 : 80),
    });
  };
}

function normalizeHost(value: string) {
  const host = value.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (!host || /[\s/@?#]/.test(host)) throw new Error("Egress host is invalid.");
  return host;
}

function cidrList(values: readonly string[]) {
  const list = new BlockList();
  for (const value of values) {
    const [address, rawPrefix, extra] = value.split("/");
    const family = isIP(address) === 6 ? "ipv6" : isIP(address) === 4 ? "ipv4" : null;
    const prefix = Number(rawPrefix);
    if (extra !== undefined || !family || !Number.isInteger(prefix) || prefix < 0 || prefix > (family === "ipv4" ? 32 : 128)) throw new Error("Private egress CIDR is invalid.");
    list.addSubnet(address, prefix, family);
  }
  return list;
}
