import "server-only";

import { createDatabaseExecutor } from "@/modules/integrations/database-automation/database-executor.factory";
import { discoveryFailureDetail } from "@/modules/integrations/database-automation/database-executor.shared";
import type { DiscoveredDatabaseObject } from "@/modules/integrations/database-automation/database-executor.port";

import type { ExecutionBoundary } from "./execution-boundary";
import type { EnvConfig, RunExecutionBundle } from "./run-persistence.service";
import {
  loadRunDatabaseDiscovery,
  recordRunDatabaseDiscovery,
} from "./run-persistence.service";

/**
 * Ask the run's own database account which non-system objects it can see, once
 * per run. This replaces the tester-managed schema allowlist: the account's
 * real privileges are the boundary.
 *
 * The recorded row is the cache. A reclaimed worker reuses it rather than
 * re-discovering, so a run's database surface is fixed for its whole life even
 * if the account's grants change mid-run.
 */

export const DATABASE_DISCOVERY_UNAVAILABLE_MESSAGE =
  "No accessible database objects were discovered with the supplied account. Verify the database credentials and account permissions.";

export type RunDatabaseDiscovery = {
  available: boolean;
  objects: DiscoveredDatabaseObject[];
  truncated: boolean;
};

const UNAVAILABLE: RunDatabaseDiscovery = { available: false, objects: [], truncated: false };

export async function ensureRunDatabaseDiscovery(input: {
  bundle: RunExecutionBundle;
  env: EnvConfig;
  boundary: ExecutionBoundary;
  signal: AbortSignal;
}): Promise<RunDatabaseDiscovery> {
  const database = input.env.database;
  const jobId = input.bundle.run.jobId;
  if (!database || !jobId) return UNAVAILABLE;

  const existing = await loadRunDatabaseDiscovery(input.bundle.run.id);
  if (existing) {
    return existing.status === "succeeded" && existing.objects.length > 0
      ? { available: true, objects: existing.objects, truncated: existing.truncated }
      : UNAVAILABLE;
  }

  const password = input.bundle.connectionSecrets.get("db.password");
  const record = {
    runId: input.bundle.run.id,
    jobId,
    workspaceId: input.bundle.run.workspaceId,
    projectId: input.bundle.run.projectId,
    azureProjectId: input.bundle.run.azureProjectId,
    driver: database.driver,
  };
  if (!password) {
    await recordRunDatabaseDiscovery({
      ...record,
      status: "failed",
      truncated: false,
      errorCode: "missing-credential",
      errorMessage: "The database password is not configured.",
      objects: [],
    });
    return UNAVAILABLE;
  }

  const executor = createDatabaseExecutor({
    ...database,
    boundary: input.boundary,
    password,
    signal: input.signal,
  });
  try {
    const discovered = await executor.discoverObjects();
    await recordRunDatabaseDiscovery({
      ...record,
      status: "succeeded",
      truncated: discovered.truncated,
      objects: discovered.objects,
    });
    return discovered.objects.length > 0
      ? { available: true, objects: discovered.objects, truncated: discovered.truncated }
      : UNAVAILABLE;
  } catch (error) {
    // Only a classified code plus a bounded excerpt is persisted: raw driver
    // exceptions can carry connection strings and row data.
    const detail = discoveryFailureDetail(error);
    await recordRunDatabaseDiscovery({
      ...record,
      status: "failed",
      truncated: false,
      errorCode: detail.code,
      errorMessage: detail.message,
      objects: [],
    });
    return UNAVAILABLE;
  } finally {
    await executor.dispose().catch(() => undefined);
  }
}
