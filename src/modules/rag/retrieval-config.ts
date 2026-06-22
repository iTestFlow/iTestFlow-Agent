import "server-only";

import { getWorkspaceSettings } from "@/modules/workspace/workspace-settings.service";

export const DEFAULT_TOP_K = 8;
export const TOP_K_MIN = 1;
export const TOP_K_MAX = 25;

/** Clamp an arbitrary number into the supported retrieval-breadth range. */
export function clampTopK(raw: number): number {
  if (!Number.isFinite(raw)) return DEFAULT_TOP_K;
  return Math.min(TOP_K_MAX, Math.max(TOP_K_MIN, Math.trunc(raw)));
}

/**
 * Deployment-level retrieval breadth: PROJECT_CONTEXT_TOP_K from the environment
 * with a safe default. This is the fallback when a workspace has no explicit
 * override. Decoupled from the legacy filesystem runtime settings so feature
 * routes have no dependency on data/runtime-settings.json.
 */
export function getRetrievalTopKFromEnv(): number {
  return clampTopK(Number(process.env.PROJECT_CONTEXT_TOP_K ?? DEFAULT_TOP_K));
}

/**
 * Effective retrieval breadth (top-K) for a workspace: the workspace's own
 * override when set (Settings → Workspace), otherwise the deployment default
 * (env → hardcoded). Always returns a clamped, sane integer.
 */
export async function getRetrievalTopK(workspaceId: string): Promise<number> {
  const settings = await getWorkspaceSettings(workspaceId);
  if (settings?.retrievalTopK != null) return clampTopK(settings.retrievalTopK);
  return getRetrievalTopKFromEnv();
}
