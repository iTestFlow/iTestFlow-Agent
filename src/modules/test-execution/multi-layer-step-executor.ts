import "server-only";

import { createHash } from "node:crypto";

import { collectSnapshotRefs } from "@/modules/integrations/browser-automation/aria-snapshot";
import {
  addScrubValues,
  scrubDeep,
  type Scrubber,
} from "@/modules/integrations/browser-automation/output-scrubber";
import type { LLMRequestLogMetadata } from "@/modules/llm/llm-request-log.service";
import type { LLMProvider } from "@/modules/llm/llm-types";
import { TEST_EXECUTION_AGENT_PROMPT } from "@/modules/llm/prompts";
import { canonicalJson } from "@/modules/shared/canonical-json";
import { redactExactValuesDeep } from "@/modules/shared/sensitive-data";
import type { DiscoveredDatabaseObject } from "@/modules/integrations/database-automation/database-executor.port";

import { AGENT_ACTION_TYPES, AgentDecisionSchema, type AgentAction, type AgentActionType, type LayerHint } from "./action-schema";
import { CaseCaptureStore } from "./case-capture-store";
import { boundedDatabaseObjectManifest } from "./database-object-manifest";
import {
  describeMultiLayerAction,
  validateCapabilityParameters,
  validateCapabilityRequestBody,
  validateMultiLayerDecision,
  type ExecutionLayer,
  type IntegrationCapability,
  type LegacyExecutionPolicy,
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
/** Settle wait before confirming a suspected no-progress UI transition. */
const NO_PROGRESS_SETTLE_MS = 400;

/**
 * UI actions that interact with the page and can therefore make (or fail to
 * make) observable progress. Passive observation/wait actions are exempt from
 * the no-progress guard: a successful waitForText is *defined* by the page
 * not changing.
 */
const EFFECTFUL_UI_ACTION_TYPES: ReadonlySet<AgentActionType> = new Set([
  "navigate", "click", "fill", "select", "check", "uncheck", "hover", "pressKey",
]);

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
  /**
   * One engine, two modes (merge ≠ genericize):
   * - "test_step" (default): UI/API/DB with normal step-completion criteria.
   * - "login": layers restricted to UI only — the validator deterministically
   *   rejects any api/db action — with the login plan's own completion
   *   criteria and credential-safe handling. Login has no case/step rows, so
   *   callers pass no persist hooks.
   */
  mode?: "test_step" | "login";
  caseTitle: string;
  stepIndex: number;
  stepTotal: number;
  instruction: string;
  expectedResult: string;
  layerHint: LayerHint;
  priorStepsSummary: readonly string[];
  executionNotes?: string;
  /** Per-run guidance entered at review; wins over environment notes on conflict. */
  runNotes?: string;
  secretNames: readonly string[];
  secretTitles?: ReadonlyMap<string, string>;
  testUsers?: readonly { handle: string; username: string; passwordPlaceholder: string | null; notes?: string }[];
  secrets: ReadonlyMap<string, string>;
  allowedOrigin?: string;
  /** Explicit "METHOD /path" requests extracted from the frozen step text and notes. */
  allowedApiRequests: ReadonlySet<string>;
  capabilities: readonly IntegrationCapability[];
  /** Discovered database objects; ranked into the prompt once per step. */
  databaseObjects?: readonly DiscoveredDatabaseObject[];
  /** Present only for runs frozen before intent-v1; restores their original gates. */
  legacyPolicy?: LegacyExecutionPolicy;
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
  // Replay protection is specifically for API/DB mutations. UI repeat safety
  // is governed by observed progress (the no-progress guard below), never by
  // fingerprint hard-blocks — a repeated Create click that visibly progresses
  // is intentionally permitted. All of this state is per step.
  const executedMutations = new Set<string>();
  const mutationReplayStrikes = new Map<string, number>();
  const noProgressStrikes = new Map<string, number>();
  const policyStrikes = new Map<string, number>();
  const capabilityMap = new Map(input.capabilities.map((capability) => [capability.id, capability]));
  const deadline = Date.now() + MULTI_LAYER_STEP_WALL_CLOCK_MS;
  let uiSnapshot: { text: string; url: string | null } | null = null;
  let feedback: string | null = null;
  let invalidCount = 0;
  let modelFailureCount = 0;
  let actionFailureCount = 0;
  let scrub = input.scrub;

  /**
   * A mutation replay strike resets only after a *different* effectful action
   * that showed observed progress — a passive read must never launder a
   * replay strike (mutation → read → mutation would escalate never).
   */
  const resetOtherReplayStrikes = (except: string | null) => {
    for (const key of [...mutationReplayStrikes.keys()]) {
      if (key !== except) mutationReplayStrikes.delete(key);
    }
  };

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

  // Login mode restricts the engine to the UI layer: any api/db proposal is
  // deterministically rejected by the shared validator as unconfigured.
  const configuredLayers: ReadonlySet<ExecutionLayer> = input.mode === "login"
    ? new Set<ExecutionLayer>([...input.runtime.configuredLayers].filter((layer) => layer === "ui"))
    : input.runtime.configuredLayers;

  // The step context is constant for the whole loop — rank the capability
  // manifest once per step, not once per model call.
  // A rejected proposal belongs to the layer the step is working in.
  const rejectionLayer: ExecutionLayer = configuredLayers.has(input.layerHint as ExecutionLayer)
    ? input.layerHint as ExecutionLayer
    : configuredLayers.size === 1
      ? [...configuredLayers][0]
      : "ui";

  const capabilityManifestLines = boundedCapabilityManifest(
    input.capabilities,
    `${input.caseTitle} ${input.instruction} ${input.expectedResult}`,
  );
  const databaseObjectLines = boundedDatabaseObjectManifest(
    input.databaseObjects ?? [],
    `${input.caseTitle} ${input.instruction} ${input.expectedResult}`,
  );

  if (shouldInspectUiInitially(input.layerHint, configuredLayers)) {
    uiSnapshot = await input.runtime.inspectUi();
    observedLayers.add("ui");
  }

  for (let iteration = 1; iteration <= MULTI_LAYER_MAX_ITERATIONS; iteration += 1) {
    if (input.signal.aborted) throw new Error("Execution aborted.");
    if (Date.now() > deadline) return finish("needs_review", iteration - 1, { reason: "The step's time budget was exhausted." });
    if (input.llmCallBudget.remaining <= 0) return finish("needs_review", iteration - 1, { reason: "The run's AI call budget was exhausted." });

    const refs = collectSnapshotRefs(uiSnapshot?.text ?? "");
    const user = scrub(buildMultiLayerPrompt(input, configuredLayers, capabilityManifestLines, databaseObjectLines, uiSnapshot, transcript, recentObservations, feedback));
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
      configuredLayers,
      snapshotRefs: refs,
      allowedOrigin: input.allowedOrigin,
      allowedApiRequests: input.allowedApiRequests,
      secretNames: input.secretNames,
      captureNames: input.captures.names(),
      capabilities: capabilityMap,
      legacyPolicy: input.legacyPolicy,
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
      transcript.push({ layer: inferredLayer(raw, rejectionLayer), actionType: "rejected", description: "Proposed action rejected", result: "rejected", detail: validated.feedback });
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
      ) ?? (resolvedAction.type === "api_execute_operation"
        ? validateCapabilityRequestBody(resolvedAction.capability, resolvedAction.arguments.body)
        : null);
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
    // Fingerprints derive from the RESOLVED action so a capture/literal alias
    // of the same mutation is recognized as a replay. They stay in worker
    // memory only and are never persisted.
    const fingerprint = safetyClass === "mutation" ? mutationFingerprint(resolvedAction) : null;
    if (fingerprint && executedMutations.has(fingerprint)) {
      // Feedback-first replay handling: the replay itself is never executed.
      // First proposal after execution gets validator feedback; proposing the
      // same replay again without intervening progress ends in human review.
      const strikes = (mutationReplayStrikes.get(fingerprint) ?? 0) + 1;
      mutationReplayStrikes.set(fingerprint, strikes);
      const message = "An identical mutation was already executed in this step. Use the earlier observation instead of replaying it.";
      transcript.push({
        layer: action.layer,
        actionType: action.type,
        description: describeMultiLayerAction(action),
        result: "rejected",
        detail: message,
      });
      if (strikes >= 2) {
        return finish("needs_review", iteration, {
          reason: "The same mutation was proposed again after replay feedback; a human should review the step.",
        });
      }
      feedback = `${message} If the step genuinely requires executing it twice, report blocked with the reason.`;
      continue;
    }

    const isEffectfulUi = action.type === "ui_action" && EFFECTFUL_UI_ACTION_TYPES.has(action.action.type);
    const preUiDigest = isEffectfulUi ? snapshotDigest(uiSnapshot) : null;

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

    if (fingerprint) executedMutations.add(fingerprint);
    let observation: LayerRuntimeObservation;
    try {
      observation = await input.runtime.execute(resolvedAction);
    } catch (error) {
      const detail = scrub(error instanceof Error ? error.message : "Layer execution failed.").slice(0, 1_000);
      // Only API/DB mutations have unknowable external outcomes worth a human
      // review; UI actions and reads report plain infrastructure failures.
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
    // Exact scalar redaction (any-length string secrets, >=4-digit numeric
    // secrets) backs up the substring scrubber, which must skip short values.
    const exactSensitiveValues = collectExactSensitiveValues(input.captures, input.secrets);
    const sanitizedSummary = scrub(observation.summary).slice(0, 1_000);
    const safeData = scrubObservationData(
      redactExactValuesDeep(observation.data, exactSensitiveValues, "[REDACTED]"),
      scrub,
    );
    recentObservations.push({ layer: action.layer, summary: sanitizedSummary, data: safeData });
    if (recentObservations.length > 6) recentObservations.shift();

    const persistedObservation = {
      summary: sanitizedSummary,
      durationMs: observation.durationMs,
      data: safeData,
      captures: redactExactValuesDeep(
        scrubDeep(input.captures.persistable(), scrub),
        exactSensitiveValues,
        "<redacted>",
      ),
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

      if (isEffectfulUi && preUiDigest) {
        let postUiDigest = snapshotDigest(uiSnapshot);
        if (postUiDigest !== null && postUiDigest === preUiDigest) {
          // Confirm before striking: async rendering can make a real change
          // look like no progress. One settle re-inspection, only on this
          // suspect path — the normal path pays no added latency.
          try {
            await settleDelay(NO_PROGRESS_SETTLE_MS, input.signal);
            uiSnapshot = await input.runtime.inspectUi();
            postUiDigest = snapshotDigest(uiSnapshot);
          } catch {
            // Keep the original snapshot; the digest comparison stands.
          }
        }
        if (postUiDigest !== null && postUiDigest === preUiDigest) {
          // The action's own transition changed nothing (pre == post).
          const key = `ui:${stableJson(action.action)}:${preUiDigest}`;
          const strikes = (noProgressStrikes.get(key) ?? 0) + 1;
          noProgressStrikes.set(key, strikes);
          if (strikes >= 3) {
            return finish("needs_review", iteration, {
              reason: "The same UI action was repeated without any observable page change.",
            });
          }
          if (strikes === 2) {
            feedback = "The repeated UI action produced no observable page change. Choose a different action or report the step outcome.";
          }
        } else {
          // Visible UI progress counts as effectful progress for replay resets.
          resetOtherReplayStrikes(null);
        }
      } else if (safetyClass === "mutation") {
        // A different successful mutation is effectful observed progress.
        resetOtherReplayStrikes(fingerprint);
      }
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
      if (observation.category !== "policy") {
        return finish("blocked_prerequisite", iteration, { reason: sanitizedSummary });
      }
      // Feedback-first policy handling: the first rejection from a given
      // policy wall is surfaced to the model; only repeating into the SAME
      // wall (stable code where available, normalized text otherwise) ends
      // the step. A different policy wall is a fresh first strike.
      const wall = policyWallFingerprint(action, observation);
      const strikes = (policyStrikes.get(wall) ?? 0) + 1;
      policyStrikes.set(wall, strikes);
      if (strikes >= 2) {
        return finish("blocked_policy", iteration, { reason: sanitizedSummary });
      }
      feedback = `A policy rejected the previous action: ${sanitizedSummary}. Do not retry it; choose a different approach or report the step outcome.`;
      continue;
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
  configuredLayers: ReadonlySet<ExecutionLayer>,
  capabilityLines: readonly string[],
  databaseObjectLines: readonly string[],
  snapshot: { text: string; url: string | null } | null,
  transcript: readonly MultiLayerActionRecord[],
  observations: readonly { layer: ExecutionLayer; summary: string; data?: unknown }[],
  feedback: string | null,
) {
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
    `Configured layers: ${[...configuredLayers].join(", ")}`,
    input.allowedOrigin ? `UI allowed origin: ${input.allowedOrigin}` : "",
    input.allowedApiRequests.size
      ? `API endpoints named by this step or the notes (prefer these): ${[...input.allowedApiRequests].join(", ")}`
      : "",
    capabilityLines.length ? `## Offered operations\n${capabilityLines.join("\n")}` : "",
    `Available agent-value secrets: ${input.secretNames.map((name) => input.secretTitles?.get(name) ? `${name} (${input.secretTitles.get(name)})` : name).join(", ") || "(none)"}`,
    input.executionNotes?.trim() ? `## Environment notes (from the profile - context only)\n${input.executionNotes.trim()}` : "",
    input.runNotes?.trim() ? `## Run notes (for this run - context only; these take precedence over the environment notes when they conflict)\n${input.runNotes.trim()}` : "",
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
    const line = `- ${promptSafeText(capability.id)}: ${capability.layer.toUpperCase()} ${capability.safetyClass} "${promptSafeText(capability.name)}"${definition ? `; ${definition}` : ""}; ${parameterManifest(capability.parameterSchema)}${capability.requestBodySchema ? `; body${capability.requestBodyRequired ? "!" : "?"}: json` : ""}`;
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
      ? { ...action.action, value: resolvedText(captures, secrets, action.action.value, "value") }
      : action.action.type === "navigate"
        ? { ...action.action, url: resolvedText(captures, secrets, action.action.url, "url") }
        : action.action;
    return { ...action, action: browserAction as AgentAction };
  }
  if (action.type === "api_request") {
    return { ...action, arguments: {
      ...action.arguments,
      path: resolvedText(captures, secrets, action.arguments.path, "path"),
      query: captures.resolve(action.arguments.query, secrets),
      headers: captures.resolve(action.arguments.headers, secrets),
      ...(action.arguments.body === undefined
        ? {}
        : { body: captures.resolve(action.arguments.body, secrets) }),
    } };
  }
  if (action.type === "api_execute_operation" || action.type === "db_execute_operation") {
    return { ...action, arguments: {
      ...action.arguments,
      parameters: captures.resolve(action.arguments.parameters, secrets),
      ...(action.arguments.body === undefined
        ? {}
        : { body: captures.resolve(action.arguments.body, secrets) }),
    } };
  }
  if (action.type === "db_select" || action.type === "db_mutate") {
    // Placeholders inside SQL text are rewritten to named bind parameters —
    // never spliced into the SQL string — so capture/secret values stay
    // parameterized and cannot alter the statement.
    const rewritten = rewriteSqlPlaceholders(action.arguments.sql, action.arguments.parameters, captures, secrets);
    return { ...action, arguments: {
      ...action.arguments,
      sql: rewritten.sql,
      parameters: captures.resolve(rewritten.parameters, secrets),
    } };
  }
  return action;
}

/** Resolve placeholders in a string field and coerce scalar results to text. */
function resolvedText(
  captures: CaseCaptureStore,
  secrets: ReadonlyMap<string, string>,
  value: string,
  label: string,
): string {
  const resolved = captures.resolve<unknown>(value, secrets);
  if (typeof resolved === "string") return resolved;
  if (typeof resolved === "number" && Number.isFinite(resolved)) return String(resolved);
  if (typeof resolved === "boolean") return String(resolved);
  throw new Error(`The ${label} resolved to a non-text capture value; use a string-compatible capture.`);
}

/**
 * Replace {{capture:...}}/{{secret:...}} placeholders inside SQL text with
 * generated named parameters and return the augmented parameter map. The
 * resolved values ride the driver's bind path, keeping the SQL text static.
 */
function rewriteSqlPlaceholders(
  sql: string,
  parameters: Record<string, unknown>,
  captures: CaseCaptureStore,
  secrets: ReadonlyMap<string, string>,
): { sql: string; parameters: Record<string, unknown> } {
  const output: Record<string, unknown> = { ...parameters };
  const nameFor = (base: string) => {
    let name = base.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 56);
    if (!/^[A-Za-z_]/.test(name)) name = `p_${name}`;
    let candidate = name;
    let suffix = 2;
    while (Object.prototype.hasOwnProperty.call(output, candidate)) candidate = `${name}_${suffix++}`;
    return candidate;
  };
  const rewritten = sql.replace(
    /\{\{(capture|secret):([A-Za-z][A-Za-z0-9_.-]{0,63})\}\}/g,
    (placeholder, kind: string, name: string) => {
      const parameter = nameFor(`${kind}_${name}`);
      // Resolving through the store enforces the sensitive-capture guard.
      output[parameter] = captures.resolve<unknown>(placeholder, secrets);
      return `:${parameter}`;
    },
  );
  return { sql: rewritten, parameters: output };
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
  // UI actions are governed by observed progress (the no-progress guard),
  // never by mutation fingerprinting: classing them as mutations hard-blocked
  // legitimate repeats and produced false uncertain_side_effect outcomes.
  if (action.type === "ui_action") return "ui";
  if (action.type === "api_execute_operation" || action.type === "db_execute_operation") return action.capability.safetyClass;
  if (action.type === "db_mutate") return "mutation";
  if (action.type === "api_request") {
    return action.arguments.method === "GET" || action.arguments.method === "HEAD" ? "read" : "mutation";
  }
  return "read";
}

function mutationFingerprint(action: MultiLayerAction) {
  if (action.type === "api_request") {
    return `api:request:${action.arguments.method} ${action.arguments.path}:${stableJson({
      query: action.arguments.query,
      body: action.arguments.body ?? null,
    })}`;
  }
  if (action.type === "db_mutate") {
    return `db:adhoc:${createHash("sha1").update(action.arguments.sql).digest("hex")}:${stableJson(action.arguments.parameters)}`;
  }
  if (action.type !== "api_execute_operation" && action.type !== "db_execute_operation") return "";
  return `${action.layer}:${action.capability.id}:${stableJson(action.arguments.parameters)}`;
}

/** Digest of the observable UI state; null when no snapshot exists. */
function snapshotDigest(snapshot: { text: string; url: string | null } | null): string | null {
  if (!snapshot) return null;
  return createHash("sha1").update(snapshot.url ?? "").update(" ").update(snapshot.text).digest("hex");
}

function settleDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("Execution aborted."));
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Execution aborted."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Exact scalar forms of every sensitive value known to this step. */
function collectExactSensitiveValues(
  captures: CaseCaptureStore,
  secrets: ReadonlyMap<string, string>,
): Set<string> {
  const values = captures.sensitiveExactValues();
  for (const value of secrets.values()) {
    if (value) values.add(value);
  }
  return values;
}

/**
 * Identity of the policy wall an action ran into. Prefers the runtime's
 * stable machine code; falls back to summary text with dynamic parts
 * (quoted strings, numbers) normalized away so fingerprints stay stable.
 */
function policyWallFingerprint(action: MultiLayerAction, observation: LayerRuntimeObservation): string {
  const target = action.type === "api_request"
    ? action.arguments.path
    : action.type === "api_execute_operation" || action.type === "db_execute_operation"
      ? action.capability.id
      : action.type === "ui_action"
        ? action.action.type
        : action.type;
  const reason = observation.code ?? normalizePolicyText(observation.summary);
  return `${action.layer}:${action.type}:${target}:${reason}`;
}

function normalizePolicyText(text: string): string {
  return text.toLowerCase().replace(/"[^"]*"/g, "?").replace(/[0-9]+/g, "#").slice(0, 200);
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

/**
 * Layer to file a rejected proposal under. An unrecognized action type says
 * nothing about the layer, so it belongs to the step's own layer rather than
 * being reported as a UI action the agent never attempted.
 */
function inferredLayer(raw: unknown, fallback: ExecutionLayer): ExecutionLayer {
  const actionType = raw && typeof raw === "object" ? (raw as Record<string, unknown>).actionType : null;
  if (typeof actionType !== "string") return fallback;
  if (actionType.startsWith("api_")) return "api";
  if (actionType.startsWith("db_")) return "db";
  if (actionType.startsWith("ui_") || (AGENT_ACTION_TYPES as readonly string[]).includes(actionType)) return "ui";
  return fallback;
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
  return canonicalJson(value);
}

function inputError(error: unknown) {
  return error instanceof Error ? error.message : "Capture failed.";
}
