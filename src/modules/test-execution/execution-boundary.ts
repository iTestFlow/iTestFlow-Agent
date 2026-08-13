import { z } from "zod";

import { normalizeEgressHostname } from "./egress-policy.service";

/**
 * The execution boundary is the complete set of network endpoints a run may
 * reach, derived mechanically from the run's frozen environment config —
 * never from tester-managed allowlists. It is a pure function of
 * `env_config_json`, so it needs no storage or backfill: historical frozen
 * runs, profile-mode runs, and login mode all derive a boundary the same way.
 */

export const EXECUTION_BOUNDARY_VERSION = "itestflow.boundary.v1" as const;

export const BoundaryTargetSchema = z.object({
  kind: z.enum(["api", "database", "oauth", "openapi"]),
  protocol: z.enum(["http", "https", "tcp"]),
  /** Normalized host: IDNA/lowercased DNS name or canonical IP, no brackets. */
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65_535),
});
export type BoundaryTarget = z.infer<typeof BoundaryTargetSchema>;

export const ExecutionBoundarySchema = z.object({
  version: z.literal(EXECUTION_BOUNDARY_VERSION),
  /** Every network endpoint this run may reach. UI browsing stays governed by allowedOrigin. */
  targets: z.array(BoundaryTargetSchema).max(8),
});
export type ExecutionBoundary = z.infer<typeof ExecutionBoundarySchema>;

/**
 * Structural input so both the frozen `EnvConfig` and the pre-freeze
 * `EnvironmentConfigInput` shapes are accepted without adapters.
 */
export type BoundaryDerivationConfig = {
  api?: {
    baseUrl: string;
    auth?: { type: string; tokenUrl?: string } | null;
  } | null;
  database?: { host: string; port: number } | null;
};

export function deriveExecutionBoundary(config: BoundaryDerivationConfig): ExecutionBoundary {
  const targets: BoundaryTarget[] = [];
  const add = (target: BoundaryTarget | null) => {
    if (!target) return;
    const exists = targets.some(
      (entry) =>
        entry.kind === target.kind &&
        entry.protocol === target.protocol &&
        entry.host === target.host &&
        entry.port === target.port,
    );
    if (!exists) targets.push(target);
  };

  if (config.api) {
    const api = httpTarget("api", config.api.baseUrl);
    add(api);
    // OpenAPI discovery is same-origin with the API base URL by construction
    // (validateSameOriginUrls), so the openapi target always mirrors it.
    if (api) add({ ...api, kind: "openapi" });
    const auth = config.api.auth;
    if (auth?.type === "oauth2_client_credentials" && auth.tokenUrl) {
      add(httpTarget("oauth", auth.tokenUrl));
    }
  }

  if (config.database) {
    const host = safeNormalizeHost(config.database.host);
    const port = config.database.port;
    if (host && Number.isInteger(port) && port >= 1 && port <= 65_535) {
      add({ kind: "database", protocol: "tcp", host, port });
    }
  }

  return { version: EXECUTION_BOUNDARY_VERSION, targets };
}

/**
 * Config values are Zod-validated upstream, so failures here are abnormal;
 * skipping the entry is fail-closed — an underivable target is simply never
 * authorized at the wire.
 */
function httpTarget(kind: "api" | "oauth", url: string): BoundaryTarget | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const host = safeNormalizeHost(parsed.hostname);
  if (!host) return null;
  const protocol = parsed.protocol === "https:" ? "https" : "http";
  const port = parsed.port ? Number(parsed.port) : protocol === "https" ? 443 : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return { kind, protocol, host, port };
}

function safeNormalizeHost(value: string): string | null {
  try {
    return normalizeEgressHostname(value);
  } catch {
    return null;
  }
}
