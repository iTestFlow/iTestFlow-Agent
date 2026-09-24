import "server-only";

import { decryptSecret } from "@/modules/security/encryption.service";
import { checkApiConnection } from "@/modules/integrations/api-automation/api-connection-check";
import { authorizeEgressTarget, createEgressAuthorizer, type EgressBoundary, type EgressTarget } from "@/modules/integrations/api-automation/egress-boundary";
import { checkDatabaseConnection } from "@/modules/integrations/database-automation/database-executor.factory";
import { sanitizeExecutionError } from "./execution-redaction";
import { toApiExecutorConfig, toDatabaseExecutorConfig } from "./execution-connections.adapters";
import { type PreparedConnection } from "./execution-connections.service";

function targetFromUrl(value: string, kind: EgressTarget["kind"]): EgressTarget {
  const url = new URL(value);
  return { kind, protocol: url.protocol === "https:" ? "https" : "http", host: url.hostname,
    port: Number(url.port) || (url.protocol === "https:" ? 443 : 80) };
}

/** Same guarded transport and DNS policy as worker execution. No writes occur. */
export async function checkExecutionConnection(entry: PreparedConnection): Promise<{
  connected: boolean; authenticated: boolean; message?: string;
}> {
  const credentials = entry.encryptedCredentials
    ? JSON.parse(decryptSecret(entry.encryptedCredentials)) as Record<string, string>
    : {};
  const secrets = Object.values(credentials);
  const signal = AbortSignal.timeout(35_000);
  const privateCidrs = (process.env.TEST_EXECUTION_PRIVATE_CIDRS ?? "").split(",").map((cidr) => cidr.trim()).filter(Boolean);
  try {
    if (entry.settings.kind === "api") {
      const boundary: EgressBoundary = {
        targets: [targetFromUrl(entry.settings.baseUrl, "api"),
          ...(entry.settings.auth.type === "oauth2ClientCredentials" ? [targetFromUrl(entry.settings.auth.tokenUrl, "oauth")] : []),
          ...(entry.settings.openApiUrl ? [targetFromUrl(entry.settings.openApiUrl, "openapi")] : [])],
        privateCidrs,
      };
      const config = toApiExecutorConfig({ ...entry.settings, credentials }, signal, createEgressAuthorizer(boundary));
      const result = await checkApiConnection(config);
      return { ...result, message: result.message ? sanitizeExecutionError(result.message, secrets) : undefined };
    }
    const boundary: EgressBoundary = { targets: [], privateCidrs };
    const config = toDatabaseExecutorConfig({ ...entry.settings, credentials }, signal,
      (target: { host: string; port: number }) => authorizeEgressTarget(boundary, { kind: "db", protocol: "tcp", host: target.host, port: target.port }));
    boundary.targets = [{ kind: "db", protocol: "tcp", host: config.host, port: config.port }];
    const result = await checkDatabaseConnection(config);
    return { ...result, message: result.message ? sanitizeExecutionError(result.message, secrets) : undefined };
  } catch (error) {
    return { connected: false, authenticated: false,
      message: sanitizeExecutionError(error instanceof Error ? error.message : "Connection check failed.", secrets) };
  }
}
