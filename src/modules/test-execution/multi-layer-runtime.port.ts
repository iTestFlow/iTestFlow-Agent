import type { PageSnapshot } from "@/modules/integrations/browser-automation/browser-executor.port";

import type { ExecutionLayer, MultiLayerAction } from "./multi-layer-action";

export type LayerRuntimeObservation = {
  status: "ok" | "failed" | "blocked" | "uncertain";
  category?: "policy" | "prerequisite" | "timeout" | "transport" | "action";
  summary: string;
  durationMs: number;
  /** Bounded and redacted evidence safe to show to the model and persist. */
  data?: unknown;
  /** Optional structured sources used by the case-local capture store. */
  apiBody?: unknown;
  dbRows?: readonly Record<string, unknown>[];
  uiSnapshot?: PageSnapshot;
};

export interface MultiLayerRuntime {
  readonly configuredLayers: ReadonlySet<ExecutionLayer>;
  /** Start/inspect UI lazily. Never called by pure API/DB steps. */
  inspectUi(): Promise<PageSnapshot>;
  /** Execute one already validated action with placeholders already resolved. */
  execute(action: MultiLayerAction): Promise<LayerRuntimeObservation>;
  /** Idempotently release API/DB resources owned by the runtime. */
  dispose(): Promise<void>;
}
