import "server-only";

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";

import { writeAuditLog } from "@/modules/audit/audit.service";
import {
  createId,
  isPgUniqueViolation,
  nowIso,
  sqlAll,
  sqlGet,
} from "@/modules/shared/infrastructure/database/db";
import {
  WorkspaceEgressRuleInputSchema,
  type WorkspaceEgressRuleInput,
} from "./schemas/test-execution.schemas";

export type TestEgressTargetKind = "api" | "database" | "oauth" | "openapi";
export type TestEgressProtocol = "http" | "https" | "tcp";

export type TestExecutionEgressAuthorization = {
  ruleId: string;
  /**
   * Concrete IP addresses authorized by the selected rule. Network adapters
   * must connect to one of these addresses instead of resolving the hostname
   * a second time.
   */
  resolvedAddresses: string[];
};

export type WorkspaceEgressRuleView = WorkspaceEgressRuleInput & {
  id: string;
  createdAt: string;
  updatedAt: string;
};

type EgressRuleRow = {
  id: string;
  name: string;
  target_kind: TestEgressTargetKind;
  protocol: TestEgressProtocol;
  host_pattern: string;
  port_from: number;
  port_to: number;
  allow_private_network: boolean;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

export class TestExecutionEgressError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "TestExecutionEgressError";
  }
}

export class TestExecutionEgressDeniedError extends TestExecutionEgressError {
  constructor(message = "The target is not allowed by the workspace test-execution egress policy.") {
    super(message, 403);
    this.name = "TestExecutionEgressDeniedError";
  }
}

const EGRESS_COLUMNS = `id, name, target_kind, protocol, host_pattern, port_from, port_to,
  allow_private_network, enabled, created_at, updated_at`;

function toView(row: EgressRuleRow): WorkspaceEgressRuleView {
  return {
    id: row.id,
    name: row.name,
    targetKind: row.target_kind,
    protocol: row.protocol,
    hostPattern: row.host_pattern,
    portFrom: row.port_from,
    portTo: row.port_to,
    allowPrivateNetwork: row.allow_private_network,
    enabled: row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listWorkspaceEgressRules(workspaceId: string): Promise<WorkspaceEgressRuleView[]> {
  const rows = await sqlAll<EgressRuleRow>(
    `SELECT ${EGRESS_COLUMNS} FROM workspace_test_egress_rules
     WHERE workspace_id = @workspaceId ORDER BY enabled DESC, name`,
    { workspaceId },
  );
  return rows.map(toView);
}

/**
 * Redirect chains and multi-hop adapters authorize every hop; a very short
 * TTL avoids one identical rule SELECT per hop without meaningfully delaying
 * policy changes (writes below invalidate immediately in this process).
 */
const RULE_CACHE_TTL_MS = 2_000;
const ruleCache = new Map<string, { at: number; rules: WorkspaceEgressRuleView[] }>();

async function listEnabledRulesCached(workspaceId: string): Promise<WorkspaceEgressRuleView[]> {
  const cached = ruleCache.get(workspaceId);
  if (cached && Date.now() - cached.at < RULE_CACHE_TTL_MS) return cached.rules;
  const rules = (await listWorkspaceEgressRules(workspaceId)).filter((rule) => rule.enabled);
  ruleCache.set(workspaceId, { at: Date.now(), rules });
  return rules;
}

function invalidateRuleCache(workspaceId: string): void {
  ruleCache.delete(workspaceId);
}

export async function createWorkspaceEgressRule(input: {
  workspaceId: string;
  actor: string;
  rule: WorkspaceEgressRuleInput;
}): Promise<WorkspaceEgressRuleView> {
  const rule = validateAndNormalizeRule(input.rule);
  const id = createId("tegr");
  const now = nowIso();
  try {
    const row = await sqlGet<EgressRuleRow>(
      `INSERT INTO workspace_test_egress_rules (
         id, workspace_id, name, target_kind, protocol, host_pattern,
         port_from, port_to, allow_private_network, enabled,
         created_by, updated_by, created_at, updated_at
       ) VALUES (
         @id, @workspaceId, @name, @targetKind, @protocol, @hostPattern,
         @portFrom, @portTo, @allowPrivateNetwork, @enabled,
         @actor, @actor, @now, @now
       ) RETURNING ${EGRESS_COLUMNS}`,
      { id, workspaceId: input.workspaceId, actor: input.actor, now, ...rule },
    );
    if (!row) throw new TestExecutionEgressError("The egress rule could not be saved.", 500);
    invalidateRuleCache(input.workspaceId);
    const view = toView(row);
    auditRule(input, view, "test_execution.egress_rule_created");
    return view;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new TestExecutionEgressError("An egress rule with this name already exists.", 409);
    }
    throw error;
  }
}

export async function updateWorkspaceEgressRule(input: {
  workspaceId: string;
  actor: string;
  ruleId: string;
  changes: Partial<WorkspaceEgressRuleInput>;
}): Promise<WorkspaceEgressRuleView | null> {
  const existing = await sqlGet<EgressRuleRow>(
    `SELECT ${EGRESS_COLUMNS} FROM workspace_test_egress_rules
     WHERE id = @id AND workspace_id = @workspaceId`,
    { id: input.ruleId, workspaceId: input.workspaceId },
  );
  if (!existing) return null;
  const rule = validateAndNormalizeRule({ ...toView(existing), ...input.changes });
  try {
    const row = await sqlGet<EgressRuleRow>(
      `UPDATE workspace_test_egress_rules SET
         name = @name, target_kind = @targetKind, protocol = @protocol,
         host_pattern = @hostPattern, port_from = @portFrom, port_to = @portTo,
         allow_private_network = @allowPrivateNetwork, enabled = @enabled,
         updated_by = @actor, updated_at = @now
       WHERE id = @id AND workspace_id = @workspaceId
       RETURNING ${EGRESS_COLUMNS}`,
      {
        id: input.ruleId,
        workspaceId: input.workspaceId,
        actor: input.actor,
        now: nowIso(),
        ...rule,
      },
    );
    if (!row) return null;
    invalidateRuleCache(input.workspaceId);
    const view = toView(row);
    auditRule(input, view, "test_execution.egress_rule_updated");
    return view;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new TestExecutionEgressError("An egress rule with this name already exists.", 409);
    }
    throw error;
  }
}

export async function deleteWorkspaceEgressRule(input: {
  workspaceId: string;
  actor: string;
  ruleId: string;
}): Promise<boolean> {
  const deleted = await sqlGet<{ id: string; name: string }>(
    `DELETE FROM workspace_test_egress_rules
     WHERE id = @id AND workspace_id = @workspaceId
     RETURNING id, name`,
    { id: input.ruleId, workspaceId: input.workspaceId },
  );
  if (!deleted) return false;
  invalidateRuleCache(input.workspaceId);
  writeAuditLog({
    workspaceId: input.workspaceId,
    entityType: "workspace_test_egress_rule",
    entityId: deleted.id,
    action: "test_execution.egress_rule_deleted",
    status: "Success",
    actor: input.actor,
    message: `Test-execution egress rule "${deleted.name}" deleted.`,
  });
  return true;
}

/**
 * Runtime authorization boundary for adapters and redirect/token/contract
 * fetches. It resolves DNS on every call, requires a matching enabled rule,
 * and rejects any private/link-local/loopback resolution unless that exact
 * rule opts into private networking.
 */
export async function assertTestExecutionEgressAllowed(input: {
  workspaceId: string;
  targetKind: TestEgressTargetKind;
  protocol: TestEgressProtocol;
  host: string;
  port: number;
}): Promise<TestExecutionEgressAuthorization> {
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65_535) {
    throw new TestExecutionEgressDeniedError();
  }
  if (
    (input.targetKind === "database" && input.protocol !== "tcp") ||
    (input.targetKind !== "database" && input.protocol === "tcp")
  ) {
    throw new TestExecutionEgressDeniedError();
  }
  const host = normalizeRequestedHost(input.host);
  const addresses = await resolveAddresses(host);
  const rules = await listEnabledRulesCached(input.workspaceId);
  const matchingRules = rules.filter((candidate) =>
    candidate.targetKind === input.targetKind &&
    candidate.protocol === input.protocol &&
    input.port >= candidate.portFrom &&
    input.port <= candidate.portTo &&
    hostPatternMatches(candidate.hostPattern, host, addresses),
  );
  if (matchingRules.length === 0) throw new TestExecutionEgressDeniedError();

  const restricted = hostIsLocallyRestricted(host) || addresses.some((address) => addressIsRestricted(address));
  const rule = restricted
    ? matchingRules.find((candidate) => candidate.allowPrivateNetwork)
    : matchingRules[0];
  if (!rule) {
    throw new TestExecutionEgressDeniedError(
      "The target resolves to a private, loopback, or link-local network not enabled by the matching rule.",
    );
  }
  const authorizedAddresses = addresses.filter((address) =>
    addressAllowedByRule(rule, host, address),
  );
  if (authorizedAddresses.length === 0) throw new TestExecutionEgressDeniedError();
  return { ruleId: rule.id, resolvedAddresses: authorizedAddresses };
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

function validateAndNormalizeRule(input: WorkspaceEgressRuleInput): WorkspaceEgressRuleInput {
  const parsed = WorkspaceEgressRuleInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new TestExecutionEgressError(parsed.error.issues[0]?.message ?? "Invalid egress rule.");
  }
  const hostPattern = normalizeHostPattern(parsed.data.hostPattern);
  if (
    (parsed.data.targetKind === "database" && parsed.data.protocol !== "tcp") ||
    (parsed.data.targetKind !== "database" && parsed.data.protocol === "tcp")
  ) {
    throw new TestExecutionEgressError("Database rules use TCP; API, OAuth, and OpenAPI rules use HTTP or HTTPS.");
  }
  return { ...parsed.data, hostPattern };
}

function normalizeHostPattern(value: string): string {
  const pattern = value.trim().toLowerCase();
  if (pattern.includes("/")) {
    const [address, prefixText, extra] = pattern.split("/");
    const version = isIP(address ?? "");
    const prefix = Number(prefixText);
    const max = version === 4 ? 32 : version === 6 ? 128 : -1;
    if (extra !== undefined || !Number.isInteger(prefix) || prefix < 0 || prefix > max) {
      throw new TestExecutionEgressError("Use a valid IPv4 or IPv6 CIDR host pattern.");
    }
    return `${normalizeIp(address as string)}/${prefix}`;
  }
  if (pattern.startsWith("*.")) {
    const suffix = normalizeDnsName(pattern.slice(2));
    if (!suffix.includes(".")) throw new TestExecutionEgressError("Wildcard rules require a qualified domain suffix.");
    return `*.${suffix}`;
  }
  if (pattern.includes("*")) {
    throw new TestExecutionEgressError("A wildcard is permitted only as the leading '*.' label.");
  }
  return isIP(stripIpv6Brackets(pattern))
    ? normalizeIp(stripIpv6Brackets(pattern))
    : normalizeDnsName(pattern);
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
    throw new TestExecutionEgressError("Use a valid hostname or CIDR host pattern.");
  }
  const labels = ascii.split(".");
  if (labels.some((label) => !label || label.length > 63 || label.startsWith("-") || label.endsWith("-"))) {
    throw new TestExecutionEgressError("Use a valid hostname or CIDR host pattern.");
  }
  return ascii;
}

function stripIpv6Brackets(value: string): string {
  return value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
}

/**
 * Normalize a connection hostname the same way the policy boundary does:
 * brackets stripped, IPs canonicalized, DNS names lowercased/ASCII. Shared
 * with the database egress adapter so the two can never disagree.
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

function hostPatternMatches(pattern: string, host: string, addresses: string[]): boolean {
  if (pattern.includes("/")) return addresses.some((address) => ipMatchesCidr(address, pattern));
  const patternIpVersion = isIP(pattern);
  if (patternIpVersion) {
    const exactCidr = `${pattern}/${patternIpVersion === 4 ? 32 : 128}`;
    return ipMatchesCidr(host, exactCidr) || addresses.some((address) => ipMatchesCidr(address, exactCidr));
  }
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(1);
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return host === pattern || addresses.includes(pattern);
}

function addressAllowedByRule(
  rule: WorkspaceEgressRuleView,
  host: string,
  address: string,
): boolean {
  const pattern = rule.hostPattern;
  if (pattern.includes("/")) return ipMatchesCidr(address, pattern);
  const patternIpVersion = isIP(pattern);
  if (patternIpVersion) {
    const exactCidr = `${pattern}/${patternIpVersion === 4 ? 32 : 128}`;
    return ipMatchesCidr(address, exactCidr);
  }
  // An exact or wildcard hostname rule authorizes all of that hostname's
  // current resolutions. Private resolutions were already rejected above
  // unless this selected rule explicitly allows private networking.
  return hostPatternMatches(pattern, host, [address]);
}

function hostIsLocallyRestricted(host: string): boolean {
  return host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local");
}

/**
 * Whether a concrete IP is private/loopback/link-local/special-purpose —
 * including the IPv4 embedded in transitional IPv6 forms. Exported for the
 * transitional-embedding unit tests.
 */
export function addressIsRestricted(address: string): boolean {
  if (isIP(address) === 4) {
    return [
      "0.0.0.0/8",
      "10.0.0.0/8",
      "100.64.0.0/10",
      "127.0.0.0/8",
      "169.254.0.0/16",
      "172.16.0.0/12",
      "192.168.0.0/16",
      "224.0.0.0/4",
      "240.0.0.0/4",
    ].some((cidr) => ipMatchesCidr(address, cidr));
  }
  if (isIP(address) === 6) {
    // Transitional embeddings (IPv4-mapped, NAT64, 6to4, IPv4-compatible,
    // Teredo) are judged by their embedded IPv4: a private embedded address
    // is restricted, a public one follows normal policy. The prefixes
    // themselves are deliberately NOT blanket-restricted — NAT64/6to4 can
    // legitimately embed public destinations.
    if (embeddedIpv4Addresses(address).some((embedded) => addressIsRestricted(embedded))) {
      return true;
    }
    return ["::/128", "::1/128", "fc00::/7", "fe80::/10", "ff00::/8"]
      .some((cidr) => ipMatchesCidr(address, cidr));
  }
  return true;
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

function isUniqueViolation(error: unknown): boolean {
  return isPgUniqueViolation(error);
}

function auditRule(
  input: { workspaceId: string; actor: string },
  rule: WorkspaceEgressRuleView,
  action: string,
): void {
  writeAuditLog({
    workspaceId: input.workspaceId,
    entityType: "workspace_test_egress_rule",
    entityId: rule.id,
    action,
    status: "Success",
    actor: input.actor,
    message: `Test-execution egress rule "${rule.name}" saved.`,
    details: {
      targetKind: rule.targetKind,
      protocol: rule.protocol,
      hostPattern: rule.hostPattern,
      portFrom: rule.portFrom,
      portTo: rule.portTo,
      allowPrivateNetwork: rule.allowPrivateNetwork,
      enabled: rule.enabled,
    },
  });
}
