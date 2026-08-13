import "server-only";

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";

/**
 * Network authorization for test-execution egress. Every outbound hop (API
 * request, redirect, OAuth token fetch, OpenAPI discovery, database connect)
 * is authorized against the run's derived execution boundary — the exact
 * endpoints named by the frozen environment config. DNS is resolved on every
 * call and the resolved addresses are pinned by the transports.
 *
 * Private-network destinations are denied by default. A deployment opts in
 * selectively via TEST_EXECUTION_PRIVATE_NETWORK_CIDRS (comma-separated CIDRs
 * or bare IPs); link-local/metadata, multicast, unspecified, and reserved
 * addresses are never allowed regardless of the allowlist.
 */

export type TestEgressTargetKind = "api" | "database" | "oauth" | "openapi";
export type TestEgressProtocol = "http" | "https" | "tcp";

/** One endpoint of a run's execution boundary (structural to avoid an import cycle). */
export type EgressBoundaryTarget = {
  kind: TestEgressTargetKind;
  protocol: TestEgressProtocol;
  host: string;
  port: number;
};

export type TestExecutionEgressAuthorization = {
  /**
   * Concrete IP addresses authorized for this hop. Network adapters must
   * connect to one of these addresses instead of resolving the hostname a
   * second time.
   */
  resolvedAddresses: string[];
};

export class TestExecutionEgressError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "TestExecutionEgressError";
  }
}

export class TestExecutionEgressDeniedError extends TestExecutionEgressError {
  constructor(message = "The target is not allowed by the test-execution network policy.") {
    super(message, 403);
    this.name = "TestExecutionEgressDeniedError";
  }
}

export const PRIVATE_NETWORK_CIDRS_ENV = "TEST_EXECUTION_PRIVATE_NETWORK_CIDRS";

/**
 * Runtime authorization boundary for adapters and redirect/token/contract
 * fetches. The boundary target is matched exactly (kind, protocol, host,
 * port); only then is the host resolved, so arbitrary names are never looked
 * up. Restricted resolutions follow the two-tier private-network policy.
 */
export async function assertBoundaryEgressAllowed(
  boundary: { targets: readonly EgressBoundaryTarget[] },
  request: {
    targetKind: TestEgressTargetKind;
    protocol: TestEgressProtocol;
    host: string;
    port: number;
  },
): Promise<TestExecutionEgressAuthorization> {
  if (!Number.isInteger(request.port) || request.port < 1 || request.port > 65_535) {
    throw new TestExecutionEgressDeniedError();
  }
  if (
    (request.targetKind === "database" && request.protocol !== "tcp") ||
    (request.targetKind !== "database" && request.protocol === "tcp")
  ) {
    throw new TestExecutionEgressDeniedError();
  }
  const host = normalizeRequestedHost(request.host);
  const matched = boundary.targets.some(
    (target) =>
      target.kind === request.targetKind &&
      target.protocol === request.protocol &&
      target.port === request.port &&
      normalizedTargetHost(target.host) === host,
  );
  if (!matched) {
    throw new TestExecutionEgressDeniedError(
      "The target is outside this run's configured execution boundary.",
    );
  }

  const addresses = await resolveAddresses(host);
  if (addresses.some((address) => addressIsHardDenied(address))) {
    throw new TestExecutionEgressDeniedError(
      "The target resolves to a link-local, multicast, or reserved network that is never allowed.",
    );
  }
  const allowlist = privateNetworkAllowlist();
  const hostRestricted = hostIsLocallyRestricted(host);
  for (const address of addresses) {
    if ((hostRestricted || addressIsSoftRestricted(address)) && !addressWithinAllowlist(address, allowlist)) {
      throw new TestExecutionEgressDeniedError(
        `The target resolves to a private, loopback, or local network. Add its range to ${PRIVATE_NETWORK_CIDRS_ENV} on this deployment to allow it.`,
      );
    }
  }
  return { resolvedAddresses: addresses };
}

/** Boundary hosts are normalized at derivation; re-normalize defensively. */
function normalizedTargetHost(value: string): string | null {
  try {
    return normalizeEgressHostname(value);
  } catch {
    return null;
  }
}

type HostResolver = (host: string) => Promise<string[]>;
let hostResolver: HostResolver = async (host) => {
  if (isIP(host)) return [host];
  const results = await lookup(host, { all: true, verbatim: true });
  return [...new Set(results.map((entry) => entry.address))];
};

/** Test-only seam; pass null to restore real DNS resolution. */
export function setTestExecutionEgressResolverForTests(resolver: HostResolver | null): void {
  hostResolver = resolver ?? (async (host) => {
    if (isIP(host)) return [host];
    const results = await lookup(host, { all: true, verbatim: true });
    return [...new Set(results.map((entry) => entry.address))];
  });
}

async function resolveAddresses(host: string): Promise<string[]> {
  try {
    const addresses = await hostResolver(host);
    if (addresses.length === 0 || addresses.some((address) => isIP(address) === 0)) {
      throw new Error("Invalid DNS response.");
    }
    return [...new Set(addresses.map(normalizeIp))];
  } catch {
    throw new TestExecutionEgressDeniedError("The target host could not be resolved safely.");
  }
}

/**
 * Deployment-level opt-in for private-network targets. Parsed lazily and
 * memoized on the raw value so tests using stubbed env vars see changes
 * immediately. Malformed entries are ignored (fail-closed) with one warning
 * per distinct raw value.
 */
let allowlistCache: { raw: string; cidrs: string[] } | null = null;

function privateNetworkAllowlist(): string[] {
  const raw = process.env[PRIVATE_NETWORK_CIDRS_ENV] ?? "";
  if (allowlistCache && allowlistCache.raw === raw) return allowlistCache.cidrs;
  const cidrs: string[] = [];
  for (const entry of raw.split(",").map((value) => value.trim()).filter(Boolean)) {
    const cidr = normalizeCidrEntry(entry);
    if (cidr) {
      cidrs.push(cidr);
    } else {
      console.warn(
        `[test-execution] Ignoring malformed ${PRIVATE_NETWORK_CIDRS_ENV} entry "${entry}" — use IPv4/IPv6 CIDRs or bare IPs.`,
      );
    }
  }
  allowlistCache = { raw, cidrs };
  return cidrs;
}

/** Accepts "10.0.0.0/8", "127.0.0.1" (→ /32), or "::1" (→ /128). */
function normalizeCidrEntry(value: string): string | null {
  const entry = value.toLowerCase();
  if (entry.includes("/")) {
    const [address, prefixText, extra] = entry.split("/");
    const version = isIP(address ?? "");
    const prefix = Number(prefixText);
    const max = version === 4 ? 32 : version === 6 ? 128 : -1;
    if (extra !== undefined || !Number.isInteger(prefix) || prefix < 0 || prefix > max) return null;
    return `${normalizeIp(address as string)}/${prefix}`;
  }
  const bare = stripIpv6Brackets(entry);
  const version = isIP(bare);
  if (version === 0) return null;
  return `${normalizeIp(bare)}/${version === 4 ? 32 : 128}`;
}

function addressWithinAllowlist(address: string, cidrs: readonly string[]): boolean {
  if (cidrs.some((cidr) => ipMatchesCidr(address, cidr))) return true;
  // An IPv4-mapped IPv6 address is a literal alias of its embedded IPv4, so
  // an IPv4 allowlist entry covers it. Other transitional forms (NAT64, 6to4,
  // Teredo) route through translators and require an explicit IPv6 listing.
  const mapped = ipv4MappedAddress(address);
  return mapped !== null && cidrs.some((cidr) => ipMatchesCidr(mapped, cidr));
}

function ipv4MappedAddress(address: string): string | null {
  if (isIP(address) !== 6) return null;
  const value = ipv6ToBigInt(address);
  if (value === null) return null;
  if ((value >> BigInt(32)) !== BigInt(0xffff)) return null;
  return dottedIpv4(value & BigInt(0xffff_ffff));
}

function normalizeRequestedHost(value: string): string {
  const host = stripIpv6Brackets(value.trim().toLowerCase()).replace(/\.$/, "");
  if (!host || /[\s/?#@]/.test(host)) throw new TestExecutionEgressDeniedError();
  if (isIP(host)) return normalizeIp(host);
  if (host.includes(":")) throw new TestExecutionEgressDeniedError();
  try {
    return normalizeDnsName(host);
  } catch {
    throw new TestExecutionEgressDeniedError();
  }
}

function normalizeDnsName(value: string): string {
  const ascii = domainToASCII(value.replace(/\.$/, "").toLowerCase());
  if (!ascii || ascii.length > 253 || !/^[a-z0-9.-]+$/.test(ascii)) {
    throw new TestExecutionEgressError("Use a valid hostname.");
  }
  const labels = ascii.split(".");
  if (labels.some((label) => !label || label.length > 63 || label.startsWith("-") || label.endsWith("-"))) {
    throw new TestExecutionEgressError("Use a valid hostname.");
  }
  return ascii;
}

function stripIpv6Brackets(value: string): string {
  return value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
}

/**
 * Normalize a connection hostname the same way the policy boundary does:
 * brackets stripped, IPs canonicalized, DNS names lowercased/ASCII. Shared
 * with the boundary derivation and the database egress adapter so they can
 * never disagree.
 */
export function normalizeEgressHostname(value: string): string {
  const trimmed = stripIpv6Brackets(value.trim().toLowerCase()).replace(/\.$/, "");
  if (isIP(trimmed)) return normalizeIp(trimmed);
  return normalizeDnsName(trimmed);
}

function normalizeIp(value: string): string {
  const version = isIP(value);
  if (version === 4) return value.split(".").map(Number).join(".");
  if (version === 6) return value.toLowerCase();
  throw new TestExecutionEgressError("Use a valid IP address.");
}

function hostIsLocallyRestricted(host: string): boolean {
  return host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local");
}

/**
 * Hard tier: never reachable, regardless of the deployment allowlist —
 * link-local (incl. cloud metadata), multicast, unspecified/"this network",
 * and reserved space. Transitional IPv6 forms embedding such an IPv4 are
 * equally hard-denied.
 */
const HARD_DENIED_IPV4_CIDRS = [
  "0.0.0.0/8",
  "169.254.0.0/16",
  "224.0.0.0/4",
  "240.0.0.0/4",
] as const;
const HARD_DENIED_IPV6_CIDRS = ["::/128", "fe80::/10", "ff00::/8"] as const;

/**
 * Soft tier: denied by default but allowable through the deployment CIDR
 * allowlist — RFC1918, CGNAT, ULA, and loopback.
 */
const SOFT_DENIED_IPV4_CIDRS = [
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
] as const;
const SOFT_DENIED_IPV6_CIDRS = ["::1/128", "fc00::/7"] as const;

export function addressIsHardDenied(address: string): boolean {
  if (isIP(address) === 4) {
    return HARD_DENIED_IPV4_CIDRS.some((cidr) => ipMatchesCidr(address, cidr));
  }
  if (isIP(address) === 6) {
    if (embeddedIpv4Addresses(address).some((embedded) => addressIsHardDenied(embedded))) return true;
    return HARD_DENIED_IPV6_CIDRS.some((cidr) => ipMatchesCidr(address, cidr));
  }
  return true;
}

export function addressIsSoftRestricted(address: string): boolean {
  if (isIP(address) === 4) {
    return SOFT_DENIED_IPV4_CIDRS.some((cidr) => ipMatchesCidr(address, cidr));
  }
  if (isIP(address) === 6) {
    if (embeddedIpv4Addresses(address).some((embedded) => addressIsSoftRestricted(embedded))) return true;
    return SOFT_DENIED_IPV6_CIDRS.some((cidr) => ipMatchesCidr(address, cidr));
  }
  return true;
}

/**
 * Whether a concrete IP is private/loopback/link-local/special-purpose —
 * including the IPv4 embedded in transitional IPv6 forms. Exported for the
 * transitional-embedding unit tests.
 */
export function addressIsRestricted(address: string): boolean {
  return addressIsHardDenied(address) || addressIsSoftRestricted(address);
}

function ipMatchesCidr(address: string, cidr: string): boolean {
  const [network, prefixText] = cidr.split("/");
  const addressVersion = isIP(address);
  if (!network || addressVersion === 0 || isIP(network) !== addressVersion) return false;
  const bits = addressVersion === 4 ? 32 : 128;
  const prefix = Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > bits) return false;
  const addressValue = addressVersion === 4 ? ipv4ToBigInt(address) : ipv6ToBigInt(address);
  const networkValue = addressVersion === 4 ? ipv4ToBigInt(network) : ipv6ToBigInt(network);
  if (addressValue === null || networkValue === null) return false;
  if (prefix === 0) return true;
  const shift = BigInt(bits - prefix);
  return (addressValue >> shift) === (networkValue >> shift);
}

function ipv4ToBigInt(address: string): bigint | null {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return parts.reduce((value, part) => (value << BigInt(8)) | BigInt(part), BigInt(0));
}

function ipv6ToBigInt(address: string): bigint | null {
  const zoneIndex = address.indexOf("%");
  const clean = (zoneIndex >= 0 ? address.slice(0, zoneIndex) : address).toLowerCase();
  const halves = clean.split("::");
  if (halves.length > 2) return null;
  const parseHalf = (half: string): number[] | null => {
    if (!half) return [];
    const output: number[] = [];
    for (const token of half.split(":")) {
      if (token.includes(".")) {
        const ipv4 = ipv4ToBigInt(token);
        if (ipv4 === null) return null;
        output.push(
          Number((ipv4 >> BigInt(16)) & BigInt(0xffff)),
          Number(ipv4 & BigInt(0xffff)),
        );
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(token)) return null;
        output.push(Number.parseInt(token, 16));
      }
    }
    return output;
  };
  const left = parseHalf(halves[0] ?? "");
  const right = parseHalf(halves[1] ?? "");
  if (!left || !right) return null;
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const groups = [...left, ...Array(Math.max(0, missing)).fill(0), ...right];
  if (groups.length !== 8) return null;
  return groups.reduce((value, group) => (value << BigInt(16)) | BigInt(group), BigInt(0));
}

/**
 * Extract the IPv4 address(es) embedded in an IPv6 transitional form:
 * IPv4-mapped ::ffff:0:0/96, NAT64 well-known 64:ff9b::/96, 6to4 2002::/16
 * (bits 16–48), deprecated IPv4-compatible ::/96, and Teredo 2001::/32
 * (server address in bits 32–63; client address XOR-obfuscated in the low
 * 32 bits). Returns an empty list for ordinary IPv6 addresses.
 */
function embeddedIpv4Addresses(address: string): string[] {
  const value = ipv6ToBigInt(address);
  if (value === null) return [];
  const low32 = value & BigInt(0xffff_ffff);
  const results: string[] = [];
  // IPv4-mapped ::ffff:a.b.c.d
  if ((value >> BigInt(32)) === BigInt(0xffff)) results.push(dottedIpv4(low32));
  // NAT64 well-known prefix 64:ff9b::a.b.c.d
  if ((value >> BigInt(96)) === BigInt(0x0064_ff9b)) results.push(dottedIpv4(low32));
  // IPv4-compatible ::a.b.c.d (deprecated; excludes :: and ::1)
  if ((value >> BigInt(32)) === BigInt(0) && low32 > BigInt(1)) results.push(dottedIpv4(low32));
  // 6to4 2002:AABB:CCDD:: embeds AABBCCDD
  if ((value >> BigInt(112)) === BigInt(0x2002)) {
    results.push(dottedIpv4((value >> BigInt(80)) & BigInt(0xffff_ffff)));
  }
  // Teredo 2001:0000:server:flags:port:client(inverted)
  if ((value >> BigInt(96)) === BigInt(0x2001_0000)) {
    results.push(dottedIpv4((value >> BigInt(64)) & BigInt(0xffff_ffff)));
    results.push(dottedIpv4(low32 ^ BigInt(0xffff_ffff)));
  }
  return [...new Set(results)];
}

function dottedIpv4(value: bigint): string {
  const ipv4 = Number(value & BigInt(0xffff_ffff));
  return [24, 16, 8, 0].map((shift) => String((ipv4 >>> shift) & 255)).join(".");
}
