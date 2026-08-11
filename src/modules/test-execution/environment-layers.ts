/**
 * Single source of truth for which execution layers an environment
 * configuration provides. Both plan validation (run.service) and the live
 * layer runtime derive from here so their definitions can never drift.
 */
export type EnvironmentLayer = "ui" | "api" | "db";

export function configuredEnvironmentLayers(
  config: { initialUrl?: string | null; api?: unknown; database?: unknown },
  options: { browserAvailable?: boolean } = {},
): EnvironmentLayer[] {
  const layers: EnvironmentLayer[] = [];
  if (config.initialUrl && (options.browserAvailable ?? true)) layers.push("ui");
  if (config.api) layers.push("api");
  if (config.database) layers.push("db");
  return layers;
}
