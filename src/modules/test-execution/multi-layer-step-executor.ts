import "server-only";

import { collectSnapshotRefs } from "@/modules/integrations/browser-automation/aria-snapshot";
import {
  addScrubValues,
  scrubDeep,
  type Scrubber,
} from "@/modules/integrations/browser-automation/output-scrubber";
import type { LLMRequestLogMetadata } from "@/modules/llm/llm-request-log.service";
import type { LLMProvider } from "@/modules/llm/llm-types";
import { TEST_EXECUTION_AGENT_PROMPT } from "@/modules/llm/prompts";

import { AgentDecisionSchema, type AgentAction, type LayerHint } from "./action-schema";
import { CaseCaptureStore } from "./case-capture-store";
import {
  describeMultiLayerAction,
  validateCapabilityParameters,
  validateMultiLayerDecision,
  type ExecutionLayer,
  type IntegrationCapability,
  type MultiLayerAction,
} from "./multi-layer-action";
import type { LayerRuntimeObservation, MultiLayerRuntime } from "./multi-layer-runtime.port";
import type { ExecutionOutcome } from "./run-state";

export const MULTI_LAYER_MAX_ITERATIONS = 16;
export const MULTI_LAYER_STEP_WALL_CLOCK_MS = 3 * 60_000;
const MAX_CONSECUTIVE_INVALID = 2;
const MAX_CONSECUTIVE_MODEL_FAILURES = 2;
const MAX_CONSECUTIVE_ACTION_FAILURES = 2;
const MAX_SNAPSHOT_CHARS = 20_000;
const MAX_OBSERVATION_CHARS = 8_000;
const MAX_CAPABILITY_MANIFEST_CHARS = 12_000;

export type MultiLayerActionRecord = {
  layer: ExecutionLayer;
  actionType: string;
  description: string;
  result: "ok" | "failed" | "rejected" | "blocked" | "uncertain";
  detail?: string;
};

export type ActionPersistenceHooks = {
  start(input: {
    orderIndex: number;
    layer: ExecutionLayer;
    actionType: string;
    safetyClass: "ui" | "read" | "mutation";
    request: Record<string, unknown>;
  }): Promise<string | null>;
  finish(input: {
    actionRunId: string;
    status: "completed" | "failed" | "blocked" | "canceled" | "uncertain";
    observation?: Record<string, unknown>;
    errorCategory?:
      | "assertion"
      | "blocked_policy"
      | "blocked_prerequisite"
      | "infrastructure"
      | "timeout"
      | "canceled"
      | "uncertain_side_effect";
    errorMessage?: string;
  }): Promise<boolean>;
};

export type MultiLayerStepInput = {
  provider: LLMProvider;
  runtime: MultiLayerRuntime;
  caseTitle: string;
  stepIndex: number;
  stepTotal: number;
  instruction: string;
  expectedResult: string;
  layerHint: LayerHint;
  priorStepsSummary: readonly string[];
  executionNotes?: string;
  secretNames: readonly string[];
  secretTitles?: ReadonlyMap<string, string>;
  testUsers?: readonly { handle: string; username: string; passwordPlaceholder: string | null; notes?: string }[];
  secrets: ReadonlyMap<string, string>;
  allowedOrigin?: string;
  allowedApiReadPaths: ReadonlySet<string>;
  capabilities: readonly IntegrationCapability[];
  apiMutationsEnabled: boolean;
  databaseDmlEnabled: boolean;
  databaseDriver?: "postgres" | "sqlserver" | "mysql";
  captures: CaseCaptureStore;
  persist?: ActionPersistenceHooks;
  scrub: Scrubber;
  signal: AbortSignal;
  llmCallBudget: { remaining: number };
  metadata: LLMRequestLogMetadata;
};

export type MultiLayerStepResult = {
  outcome: ExecutionOutcome;
  actualResult?: string;
  reason?: string;
  actionsTaken: MultiLayerActionRecord[];
  iterations: number;
  observedLayers: ExecutionLayer[];
};

export async function runMultiLayerStep(input: MultiLayerStepInput): Promise<MultiLayerStepResult> {
  const transcript: MultiLayerActionRecord[] = [];
  const recentObservations: Array<{ layer: ExecutionLayer; summary: string; data?: unknown }> = [];
  const observedLayers = new Set<ExecutionLayer>();
  const mutationFingerprints = new Set<string>();
  const capabilityMap = new Map(input.capabilities.map((capability) => [capability.id, capability]));
  const deadline = Date.now() + MULTI_LAYER_STEP_WALL_CLOCK_MS;
  let uiSnapshot: { text: string; url: string | null } | null = null;
  let feedback: string | null = null;
  let invalidCount = 0;
  let modelFailureCount = 0;
  let actionFailureCount = 0;
  let scrub = input.scrub;

  const finish = (
    outcome: ExecutionOutcome,
    iterations: number,
    extra?: { actualResult?: string; reason?: string },
  ): MultiLayerStepResult => ({
    outcome,
    actualResult: extra?.actualResult ? scrub(extra.actualResult) : undefined,
    reason: extra?.reason ? scrub(extra.reason) : undefined,
    actionsTaken: transcript.map((record) => ({
      ...record,
      description: scrub(record.description),
      detail: record.detail ? scrub(record.detail) : undefined,
    })),
    iterations,
    observedLayers: [...observedLayers],
  });

  if (shouldInspectUiInitially(input.layerHint, input.runtime.configuredLayers)) {
    uiSnapshot = await input.runtime.inspectUi();
    observedLayers.add("ui");
  }

  for (let iteration = 1; iteration <= MULTI_LAYER_MAX_ITERATIONS; iteration += 1) {
    if (input.signal.aborted) throw new Error("Execution aborted.");
    if (Date.now() > deadline) return finish("needs_review", iteration - 1, { reason: "The step's time budget was exhausted." });
    if (input.llmCallBudget.remaining <= 0) return finish("needs_review", iteration - 1, { reason: "The run's AI call budget was exhausted." });

    const refs = collectSnapshotRefs(uiSnapshot?.text ?? "");
    const user = scrub(buildMultiLayerPrompt(input, uiSnapshot, transcript, recentObservations, feedback));
    input.llmCallBudget.remaining -= 1;

    let raw: unknown;
    try {
      const callSignal = AbortSignal.any([
        input.signal,
        AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      ]);
      const generated = await input.provider.generateStructuredOutput({
        schemaName: "TestExecutionAgentDecision",
        schema: AgentDecisionSchema,
        system: TEST_EXECUTION_AGENT_PROMPT.system,
        user,
        signal: callSignal,
        metadata: { ...input.metadata, logRetention: "metadata_only" },
      });
      raw = generated.validatedOutput;
      modelFailureCount = 0;
    } catch (error) {
      if (input.signal.aborted) throw new Error("Execution aborted.");
      if (Date.now() >= deadline) {
        return finish("needs_review", iteration, { reason: "The step's time budget was exhausted." });
      }
      modelFailureCount += 1;
      const detail = scrub(error instanceof Error ? error.message : "Model call failed.").slice(0, 300);
      transcript.push({ layer: "ui", actionType: "model", description: "Model response unusable", result: "failed", detail });
      if (modelFailureCount >= MAX_CONSECUTIVE_MODEL_FAILURES) {
        return finish("infrastructure_error", iteration, { reason: "The AI model repeatedly failed to produce a usable decision." });
      }
      feedback = "The previous response was unusable. Return one valid JSON object using the advertised action contract.";
      continue;
    }

    const validated = validateMultiLayerDecision(raw, {
      layerHint: input.layerHint,
      configuredLayers: input.runtime.configuredLayers,
      snapshotRefs: refs,
      allowedOrigin: input.allowedOrigin,
      allowedApiReadPaths: input.allowedApiReadPaths,
      secretNames: input.secretNames,
      captureNames: input.captures.names(),
      capabilities: capabilityMap,
      apiMutationsEnabled: input.apiMutationsEnabled,
      databaseDmlEnabled: input.databaseDmlEnabled,
      databaseDriver: input.databaseDriver,
    });

    if (validated.kind === "step_passed" || validated.kind === "step_failed") {
      const evidenceIssue = requiredEvidenceIssue(input.layerHint, observedLayers);
      if (evidenceIssue) {
        feedback = evidenceIssue;
        invalidCount += 1;
        if (invalidCount >= MAX_CONSECUTIVE_INVALID) return finish("needs_review", iteration, { reason: feedback });
        continue;
      }
      return finish(
        validated.kind === "step_passed" ? "passed" : "failed_assertion",
        iteration,
        { actualResult: validated.actualResult },
      );
    }
    if (validated.kind === "blocked") return finish("blocked_prerequisite", iteration, { reason: validated.reason });
    if (validated.kind === "invalid") {
      invalidCount += 1;
      transcript.push({ layer: inferredLayer(raw), actionType: "rejected", description: "Proposed action rejected", result: "rejected", detail: validated.feedback });
      if (invalidCount >= MAX_CONSECUTIVE_INVALID) return finish("needs_review", iteration, { reason: validated.feedback });
      feedback = validated.feedback;
      continue;
    }

    const action = validated.action;
    let resolvedAction: MultiLayerAction;
    try {
      resolvedAction = resolveAction(action, input.captures, input.secrets);
    } catch (error) {
      const detail = scrub(inputError(error)).slice(0, 500);
      transcript.push({
        layer: action.layer,
        actionType: action.type,
        description: describeMultiLayerAction(action),
        result: "rejected",
        detail,
      });
      feedback = detail;
      invalidCount += 1;
      if (invalidCount >= MAX_CONSECUTIVE_INVALID) {
        return finish("needs_review", iteration, { reason: detail });
      }
      continue;
    }
    if (resolvedAction.type === "api_execute_operation" || resolvedAction.type === "db_execute_operation") {
      const parameterIssue = validateCapabilityParameters(
        resolvedAction.capability,
        resolvedAction.arguments.parameters,
      );
      if (parameterIssue) {
        transcript.push({
          layer: resolvedAction.layer,
          actionType: resolvedAction.type,
          description: describeMultiLayerAction(resolvedAction),
          result: "rejected",
          detail: parameterIssue,
        });
        feedback = parameterIssue;
        invalidCount += 1;
        if (invalidCount >= MAX_CONSECUTIVE_INVALID) {
          return finish("needs_review", iteration, { reason: parameterIssue });
        }
        continue;
      }
    }
    invalidCount = 0;
    const safetyClass = actionSafetyClass(action);
    const fingerprint = safetyClass === "mutation" ? mutationFingerprint(resolvedAction) : null;
    if (fingerprint && mutationFingerprints.has(fingerprint)) {
      return finish("blocked_policy", iteration, { reason: "An identical mutation was already attempted in this step and cannot be replayed." });
    }

    const description = describeMultiLayerAction(action);
    const request = scrubDeep(persistableActionRequest(action), scrub);
    let actionRunId: string | null = null;
    if (input.persist) {
      actionRunId = await input.persist.start({
        orderIndex: transcript.length,
        layer: action.layer,
        actionType: action.type,
        safetyClass,
        request,
      });
      if (!actionRunId) throw new Error("The worker no longer owns this run.");
    }

    if (fingerprint) mutationFingerprints.add(fingerprint);
    let observation: LayerRuntimeObservation;
    try {
      observation = await input.runtime.execute(resolvedAction);
    } catch (error) {
      const detail = scrub(error instanceof Error ? error.message : "Layer execution failed.").slice(0, 1_000);
      const uncertain = safetyClass === "mutation";
      if (actionRunId && input.persist) {
        const finalized = await input.persist.finish({
          actionRunId,
          status: uncertain ? "uncertain" : "failed",
          errorCategory: uncertain ? "uncertain_side_effect" : "infrastructure",
          errorMessage: detail,
        });
        if (!finalized) throw new Error("The worker no longer owns this run.");
      }
      transcript.push({ layer: action.layer, actionType: action.type, description, result: uncertain ? "uncertain" : "failed", detail });
      return finish(uncertain ? "needs_review" : "infrastructure_error", iteration, { reason: detail });
    }

    if (observation.uiSnapshot) uiSnapshot = observation.uiSnapshot;
    else if (action.layer === "ui") uiSnapshot = await input.runtime.inspectUi();

    const captureErrorsRaw = applyCaptures(action, observation, input.captures);
    scrub = addScrubValues(scrub, input.captures.sensitiveScrubValues());
    const captureErrors = captureErrorsRaw.map((error) => scrub(error));
    const sanitizedSummary = scrub(observation.summary).slice(0, 1_000);
    const safeData = scrubObservationData(observation.data, scrub);
    recentObservations.push({ layer: action.layer, summary: sanitizedSummary, data: safeData });
    if (recentObservations.length > 6) recentObservations.shift();

    const persistedObservation = {
      summary: sanitizedSummary,
      durationMs: observation.durationMs,
      data: safeData,
      captures: input.captures.persistable(),
      captureErrors,
    };
    if (actionRunId && input.persist) {
      const finalized = await input.persist.finish({
        actionRunId,
        status: observation.status === "ok" ? "completed" : observation.status,
        observation: persistedObservation,
        errorCategory: persistenceErrorCategory(observation),
        errorMessage: observation.status === "ok" ? undefined : sanitizedSummary,
      });
      if (!finalized) throw new Error("The worker no longer owns this run.");
    }

    if (observation.status === "ok") {
      observedLayers.add(action.layer);
      actionFailureCount = captureErrors.length > 0 ? actionFailureCount + 1 : 0;
      feedback = captureErrors.length > 0
        ? `The external action completed, but captures failed: ${captureErrors.join("; ")}. Do not repeat a mutation; use the available observation.`
        : null;
      transcript.push({ layer: action.layer, actionType: action.type, description, result: captureErrors.length ? "failed" : "ok", detail: sanitizedSummary });
      continue;
    }

    transcript.push({
      layer: action.layer,
      actionType: action.type,
      description,
      result: observation.status,
      detail: sanitizedSummary,
    });
    if (observation.status === "uncertain") return finish("needs_review", iteration, { reason: sanitizedSummary });
    if (observation.status === "blocked") {
      return finish(observation.category === "policy" ? "blocked_policy" : "blocked_prerequisite", iteration, { reason: sanitizedSummary });
    }
    actionFailureCount += 1;
    if (actionFailureCount >= MAX_CONSECUTIVE_ACTION_FAILURES) {
      return finish(observation.category === "timeout" ? "timeout" : "needs_review", iteration, { reason: sanitizedSummary });
    }
    feedback = `The previous ${action.layer.toUpperCase()} action failed: ${sanitizedSummary}. Reassess using the latest observation.`;
  }

  return finish("needs_review", MULTI_LAYER_MAX_ITERATIONS, { reason: "The step did not complete within the allowed number of actions." });
}

function shouldInspectUiInitially(hint: LayerHint, layers: ReadonlySet<ExecutionLayer>) {
  return layers.has("ui") && (hint === "ui" || (layers.size === 1 && hint !== "api" && hint !== "db"));
}

function buildMultiLayerPrompt(
  input: MultiLayerStepInput,
  snapshot: { text: string; url: string | null } | null,
  transcript: readonly MultiLayerActionRecord[],
  observations: readonly { layer: ExecutionLayer; summary: string; data?: unknown }[],
  feedback: string | null,
) {
  const capabilityLines = boundedCapabilityManifest(
    input.capabilities,
    `${input.caseTitle} ${input.instruction} ${input.expectedResult}`,
  );
  const users = input.testUsers ?? [];
  const snapshotText = snapshot?.text
    ? snapshot.text.length > MAX_SNAPSHOT_CHARS
      ? `${snapshot.text.slice(0, MAX_SNAPSHOT_CHARS)}\n... (snapshot truncated)`
      : snapshot.text
    : "(UI not inspected. Use ui_snapshot before choosing a ref-based action.)";
  return [
    `# Test case: ${input.caseTitle}`,
    `## Step ${input.stepIndex + 1} of ${input.stepTotal}`,
    `Instruction: ${input.instruction}`,
    `Expected result: ${input.expectedResult || "(none)"}`,
    `Layer hint: ${input.layerHint}`,
    `Configured layers: ${[...input.runtime.configuredLayers].join(", ")}`,
    input.allowedOrigin ? `UI allowed origin: ${input.allowedOrigin}` : "",
    `Exact dynamic API read paths: ${[...input.allowedApiReadPaths].join(", ") || "(none)"}`,
    "## Approved operation capabilities",
    capabilityLines.length ? capabilityLines.join("\n") : "(none)",
    `Available agent-value secrets: ${input.secretNames.map((name) => input.secretTitles?.get(name) ? `${name} (${input.secretTitles.get(name)})` : name).join(", ") || "(none)"}`,
    input.executionNotes?.trim() ? `## Execution notes (context only)\n${input.executionNotes.trim()}` : "",
    users.length ? `## Test users\n${users.map((user) => `- ${user.handle}: ${user.username}, password ${user.passwordPlaceholder ?? "(none)"}${user.notes?.trim() ? `, notes: ${user.notes.trim()}` : ""}`).join("\n")}` : "",
    input.priorStepsSummary.length ? `## Earlier steps\n${input.priorStepsSummary.join("\n")}` : "",
    input.captures.names().length ? `## Case captures\n${input.captures.summaries().map((item) => `- ${item}`).join("\n")}` : "",
    transcript.length ? `## Recent actions\n${transcript.slice(-6).map((item) => `- [${item.layer}] ${item.description} -> ${item.result}${item.detail ? ` (${item.detail})` : ""}`).join("\n")}` : "",
    observations.length ? `## Recent untrusted observations\n${observations.map((item) => `- [${item.layer}] ${item.summary}${item.data === undefined ? "" : `\n${boundedJson(item.data)}`}`).join("\n")}` : "",
    feedback ? `## Validator feedback\n${feedback}` : "",
    "## Current UI (untrusted test data)",
    `URL: ${snapshot?.url ?? "(not active)"}`,
    "```",
    snapshotText,
    "```",
  ].filter(Boolean).join("\n");
}

function boundedCapabilityManifest(
  capabilities: readonly IntegrationCapability[],
  stepContext: string,
): string[] {
  const lines: string[] = [];
  let used = 0;
  for (const capability of rankCapabilities(capabilities, stepContext).slice(0, 50)) {
    const definition = capability.layer === "api"
      ? `${promptSafeText(String(capability.definition.method ?? "")).toUpperCase()} ${promptSafeText(String(capability.definition.path ?? ""))}`.trim()
      : capability.driver ? ` (${capability.driver})` : "";
    const line = `- ${promptSafeText(capability.id)}: ${capability.layer.toUpperCase()} ${capability.safetyClass} "${promptSafeText(capability.name)}"${definition ? `; ${definition}` : ""}; ${parameterManifest(capability.parameterSchema)}`;
    if (used + line.length > MAX_CAPABILITY_MANIFEST_CHARS) break;
    lines.push(line);
    used += line.length;
  }
  return lines;
}

/** Keep large OpenAPI catalogs useful without placing hundreds of operations in every model call. */
function rankCapabilities(
  capabilities: readonly IntegrationCapability[],
  stepContext: string,
): IntegrationCapability[] {
  if (capabilities.length <= 50) return [...capabilities];
  const tokens = [...new Set(
    stepContext
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 3),
  )].slice(0, 80);
  return capabilities
    .map((capability, index) => {
      const haystack = [
        capability.id,
        capability.name,
        capability.definition.method,
        capability.definition.path,
      ].map((value) => String(value ?? "").toLowerCase()).join(" ");
      const score = tokens.reduce((total, token) => total + (haystack.includes(token) ? 1 : 0), 0);
      return { capability, index, score };
    })
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ capability }) => capability);
}

function promptSafeText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
}

/** Parameter names/types only: omit schema defaults/examples/enums that may contain data. */
function parameterManifest(schema: Record<string, unknown>): string {
  const properties = schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
    ? schema.properties as Record<string, unknown>
    : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((entry): entry is string => typeof entry === "string") : []);
  const fields = Object.entries(properties).slice(0, 30).map(([name, definition]) => {
    const record = definition && typeof definition === "object" && !Array.isArray(definition)
      ? definition as Record<string, unknown>
      : {};
    const type = Array.isArray(record.type)
      ? record.type.filter((entry) => typeof entry === "string").join("|")
      : typeof record.type === "string" ? record.type : "value";
    return `${name}${required.has(name) ? "!" : "?"}:${type}`;
  });
  return fields.length > 0 ? `parameters { ${fields.join(", ")} }` : "parameters { }";
}

function resolveAction(
  action: MultiLayerAction,
  captures: CaseCaptureStore,
  secrets: ReadonlyMap<string, string>,
): MultiLayerAction {
  if (action.type === "ui_action") {
    const browserAction = action.action.type === "fill" || action.action.type === "select"
      ? { ...action.action, value: captures.resolve(action.action.value, secrets) }
      : action.action.type === "navigate"
        ? { ...action.action, url: captures.resolve(action.action.url, secrets) }
        : action.action;
    return { ...action, action: browserAction as AgentAction };
  }
  if (action.type === "api_request") {
    return { ...action, arguments: { ...action.arguments, query: captures.resolve(action.arguments.query, secrets), headers: captures.resolve(action.arguments.headers, secrets) } };
  }
  if (action.type === "api_execute_operation" || action.type === "db_execute_operation") {
    return { ...action, arguments: { ...action.arguments, parameters: captures.resolve(action.arguments.parameters, secrets) } };
  }
  if (action.type === "db_select") {
    return { ...action, arguments: { ...action.arguments, parameters: captures.resolve(action.arguments.parameters, secrets) } };
  }
  return action;
}

function applyCaptures(action: MultiLayerAction, observation: LayerRuntimeObservation, store: CaseCaptureStore): string[] {
  if (!("arguments" in action) || !("captures" in action.arguments)) return [];
  const errors: string[] = [];
  for (const capture of action.arguments.captures) {
    try {
      if (action.layer === "api") {
        if (!observation.apiBody) throw new Error("The API response has no structured body.");
        if (!capture.pointer) throw new Error("API capture requires pointer.");
        store.captureJson({ name: capture.name, pointer: capture.pointer, document: observation.apiBody, sensitive: capture.sensitive });
      } else {
        if (!observation.dbRows) throw new Error("The database observation has no rows.");
        if (!capture.column) throw new Error("Database capture requires column.");
        store.captureRow({ name: capture.name, rows: observation.dbRows, rowIndex: capture.rowIndex, column: capture.column, sensitive: capture.sensitive });
      }
    } catch (error) {
      errors.push(inputError(error));
    }
  }
  return errors;
}

function actionSafetyClass(action: MultiLayerAction): "ui" | "read" | "mutation" {
  if (action.type === "ui_snapshot") return "read";
  // Browser actions can dispatch application mutations (clicking Submit,
  // typing into autosave fields, navigation side effects). Treat an unknown
  // in-flight outcome conservatively, just like API/DB mutations.
  if (action.type === "ui_action") return "mutation";
  if (action.type === "api_execute_operation" || action.type === "db_execute_operation") return action.capability.safetyClass;
  return "read";
}

function mutationFingerprint(action: MultiLayerAction) {
  if (action.type === "ui_action") return `ui:${stableJson(action.action)}`;
  if (action.type !== "api_execute_operation" && action.type !== "db_execute_operation") return "";
  return `${action.layer}:${action.capability.id}:${stableJson(action.arguments.parameters)}`;
}

function requiredEvidenceIssue(
  hint: LayerHint,
  observedLayers: ReadonlySet<ExecutionLayer>,
): string | null {
  if (hint === "mixed" && observedLayers.size < 2) {
    return "This step is marked Mixed. Observe at least two configured layers before reporting a verdict.";
  }
  if (hint === "ui" && !observedLayers.has("ui")) return "Inspect the UI before reporting a verdict for this UI step.";
  if (hint === "api" && !observedLayers.has("api")) return "Execute an API read or approved operation before reporting a verdict for this API step.";
  if (hint === "db" && !observedLayers.has("db")) return "Inspect or query the database before reporting a verdict for this database step.";
  if (hint === "auto" && observedLayers.size === 0) return "Observe at least one configured layer before reporting a step verdict.";
  return null;
}

function persistableActionRequest(action: MultiLayerAction): Record<string, unknown> {
  if (action.type === "ui_action") return { action: action.action.type, ...redactUiValue(action.action) };
  if (action.type === "ui_snapshot") return { action: action.type };
  if (action.type === "api_execute_operation" || action.type === "db_execute_operation") {
    return { operationId: action.capability.id, operationName: action.capability.name, parameters: action.arguments.parameters, captures: action.arguments.captures };
  }
  return { ...action.arguments };
}

function redactUiValue(action: AgentAction): Record<string, unknown> {
  if (action.type === "fill" || action.type === "select") {
    return { ref: action.ref, elementDescription: action.elementDescription, value: "<not persisted>" };
  }
  return action as unknown as Record<string, unknown>;
}

function persistenceErrorCategory(observation: LayerRuntimeObservation):
  | "assertion"
  | "blocked_policy"
  | "blocked_prerequisite"
  | "infrastructure"
  | "timeout"
  | "canceled"
  | "uncertain_side_effect"
  | undefined {
  if (observation.status === "uncertain") return "uncertain_side_effect";
  if (observation.category === "policy") return "blocked_policy";
  if (observation.category === "prerequisite") return "blocked_prerequisite";
  if (observation.category === "timeout") return "timeout";
  if (observation.category === "transport") return "infrastructure";
  return observation.status === "ok" ? undefined : "assertion";
}

function inferredLayer(raw: unknown): ExecutionLayer {
  const actionType = raw && typeof raw === "object" ? (raw as Record<string, unknown>).actionType : null;
  return typeof actionType === "string" && actionType.startsWith("api_")
    ? "api"
    : typeof actionType === "string" && actionType.startsWith("db_")
      ? "db"
      : "ui";
}

function scrubObservationData(data: unknown, scrub: Scrubber): unknown {
  if (data === undefined) return undefined;
  try {
    const json = JSON.stringify(data);
    const redacted = scrub(json);
    if (redacted.length > MAX_OBSERVATION_CHARS) {
      return `${redacted.slice(0, MAX_OBSERVATION_CHARS)}... (truncated)`;
    }
    return JSON.parse(redacted);
  } catch {
    return scrub(String(data)).slice(0, MAX_OBSERVATION_CHARS);
  }
}

function boundedJson(value: unknown) {
  const json = stableJson(value);
  return json.length > MAX_OBSERVATION_CHARS ? `${json.slice(0, MAX_OBSERVATION_CHARS)}...` : json;
}

function stableJson(value: unknown) {
  try {
    return JSON.stringify(sortJson(value));
  } catch {
    return "<unserializable>";
  }
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortJson(entry)]),
    );
  }
  return value;
}

function inputError(error: unknown) {
  return error instanceof Error ? error.message : "Capture failed.";
}
