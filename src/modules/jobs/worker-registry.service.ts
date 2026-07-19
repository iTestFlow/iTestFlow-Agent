import "server-only";

import { sqlGet, sqlRun } from "@/modules/shared/infrastructure/database/db";

export const WORKER_REGISTRY_HEARTBEAT_MS = 5_000;
export const WORKER_REGISTRY_HEALTHY_MS = 20_000;

export async function registerWorkerInstance(input: {
  id: string;
  capabilities: string[];
}) {
  await sqlRun(
    `INSERT INTO worker_instances (id, capabilities_json, started_at, heartbeat_at)
     VALUES (@id, @capabilitiesJson::jsonb, NOW(), NOW())
     ON CONFLICT (id) DO UPDATE SET
       capabilities_json = EXCLUDED.capabilities_json,
       started_at = NOW(),
       heartbeat_at = NOW()`,
    { id: input.id, capabilitiesJson: JSON.stringify(Array.from(new Set(input.capabilities)).sort()) },
  );
}

export async function heartbeatWorkerInstance(id: string) {
  return (await sqlRun(
    `UPDATE worker_instances SET heartbeat_at = NOW() WHERE id = @id`,
    { id },
  )) > 0;
}

export async function unregisterWorkerInstance(id: string) {
  await sqlRun(`DELETE FROM worker_instances WHERE id = @id`, { id });
}

export async function hasHealthyWorkerCapability(
  capability: string,
  healthyForMs = WORKER_REGISTRY_HEALTHY_MS,
) {
  const row = await sqlGet<{ available: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM worker_instances
       WHERE heartbeat_at >= NOW() - (@healthyForMs * INTERVAL '1 millisecond')
         AND capabilities_json ? @capability
     ) AS available`,
    { capability, healthyForMs: Math.max(1, Math.floor(healthyForMs)) },
  );
  return Boolean(row?.available);
}

export async function removeStaleWorkerInstances(maxAgeMs = 24 * 60 * 60 * 1_000) {
  return sqlRun(
    `DELETE FROM worker_instances
     WHERE heartbeat_at < NOW() - (@maxAgeMs * INTERVAL '1 millisecond')`,
    { maxAgeMs: Math.max(WORKER_REGISTRY_HEALTHY_MS, Math.floor(maxAgeMs)) },
  );
}
