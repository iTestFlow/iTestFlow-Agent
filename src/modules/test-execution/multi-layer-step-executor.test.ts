import { describe, expect, it, vi } from "vitest";

import {
  REDACTION_MARKER,
  createScrubber,
} from "@/modules/integrations/browser-automation/output-scrubber";
import type { LLMProvider } from "@/modules/llm/llm-types";

import { CaseCaptureStore } from "./case-capture-store";
import type { IntegrationCapability, MultiLayerAction } from "./multi-layer-action";
import type { LayerRuntimeObservation, MultiLayerRuntime } from "./multi-layer-runtime.port";
import { buildScrubValues } from "./secret-resolution";
import { runMultiLayerStep, type MultiLayerStepInput } from "./multi-layer-step-executor";

function provider(outputs: Record<string, unknown>[]): LLMProvider {
  return {
    name: "openai",
    model: "test",
    testConnection: vi.fn(async () => true),
    getTokenUsage: vi.fn(() => undefined),
    generateText: vi.fn(),
    generateStructuredOutput: vi.fn(async () => ({
      provider: "openai",
      model: "test",
      rawOutput: "{}",
      validatedOutput: outputs.shift() ?? { decision: "blocked", reason: "No scripted decision" },
    })),
  } as unknown as LLMProvider;
}

class FakeRuntime implements MultiLayerRuntime {
  readonly actions: MultiLayerAction[] = [];
  inspectCount = 0;
  constructor(
    readonly configuredLayers: ReadonlySet<"ui" | "api" | "db">,
    private readonly observations: LayerRuntimeObservation[],
  ) {}
  async inspectUi() {
    this.inspectCount += 1;
    return { text: '- button "Save" [ref=e1]', url: "https://app.example.test" };
  }
  async execute(action: MultiLayerAction) {
    this.actions.push(action);
    return this.observations.shift() ?? { status: "ok", summary: "ok", durationMs: 1 };
  }
  async dispose() {}
}

function input(runtime: MultiLayerRuntime, decisions: Record<string, unknown>[], overrides: Partial<MultiLayerStepInput> = {}): MultiLayerStepInput {
  return {
    provider: provider(decisions),
    runtime,
    caseTitle: "Order flow",
    stepIndex: 0,
    stepTotal: 1,
    instruction: "GET /orders/42 and verify status",
    expectedResult: "Order is ready",
    layerHint: "auto",
    priorStepsSummary: [],
    secretNames: [],
    secrets: new Map(),
    allowedOrigin: "https://app.example.test",
    allowedApiRequests: new Set(["GET /orders/42"]),
    capabilities: [],
    captures: new CaseCaptureStore(),
    scrub: createScrubber([]),
    signal: new AbortController().signal,
    llmCallBudget: { remaining: 20 },
    metadata: { action: "test" },
    ...overrides,
  };
}

describe("runMultiLayerStep in login mode", () => {
  it("rejects API/DB proposals even when the runtime has those layers configured", async () => {
    const runtime = new FakeRuntime(new Set(["ui", "api", "db"]), []);
    const apiDecision = {
      decision: "act",
      actionType: "api_request",
      argumentsJson: JSON.stringify({ method: "GET", path: "/session" }),
    };
    const result = await runMultiLayerStep(input(runtime, [apiDecision, apiDecision], {
      mode: "login",
      layerHint: "ui",
    }));
    expect(result.outcome).toBe("needs_review");
    expect(result.actionsTaken).toEqual([
      expect.objectContaining({ result: "rejected", detail: expect.stringContaining("not configured") }),
      expect.objectContaining({ result: "rejected" }),
    ]);
    expect(runtime.actions).toHaveLength(0);
  });

  it("completes a login step with in-memory secret substitution, never persisting the value", async () => {
    const runtime = new FakeRuntime(new Set(["ui"]), [{ status: "ok", summary: "Signed in", durationMs: 1 }]);
    const llm = provider([
      {
        decision: "act",
        actionType: "fill",
        ref: "e1",
        elementDescription: "Password",
        value: "{{secret:DEFAULT_PASSWORD}}",
      },
      { decision: "step_passed", actualResult: "Dashboard visible" },
    ]);
    const result = await runMultiLayerStep(input(runtime, [], {
      provider: llm,
      mode: "login",
      layerHint: "ui",
      secretNames: ["DEFAULT_PASSWORD"],
      secrets: new Map([["DEFAULT_PASSWORD", "login-password"]]),
      scrub: createScrubber(["login-password"]),
    }));
    expect(result.outcome).toBe("passed");
    expect(runtime.actions[0]).toMatchObject({
      type: "ui_action",
      action: { type: "fill", value: "login-password" },
    });
    const prompts = vi.mocked(llm.generateStructuredOutput).mock.calls.map(([request]) => request.user).join("\n");
    expect(prompts).not.toContain("login-password");
    expect(prompts).toContain("Configured layers: ui");
  });

  it("eagerly inspects the UI so a login verdict always carries UI evidence", async () => {
    const runtime = new FakeRuntime(new Set(["ui", "api"]), []);
    const result = await runMultiLayerStep(input(runtime, [
      { decision: "step_passed", actualResult: "Dashboard heading visible after login" },
    ], {
      mode: "login",
      layerHint: "ui",
    }));
    expect(result.outcome).toBe("passed");
    expect(result.observedLayers).toEqual(["ui"]);
    expect(runtime.inspectCount).toBe(1);
  });
});

describe("runMultiLayerStep", () => {
  it("inspects UI eagerly, resolves an in-memory fill value, and never persists it", async () => {
    const runtime = new FakeRuntime(new Set(["ui"]), [{ status: "ok", summary: "Form updated", durationMs: 1 }]);
    const start = vi.fn(async () => "action-1");
    const result = await runMultiLayerStep(input(runtime, [
      {
        decision: "act",
        actionType: "fill",
        ref: "e1",
        elementDescription: "Password",
        value: "{{secret:PASSWORD}}",
      },
      { decision: "step_failed", actualResult: "The validation message was missing" },
    ], {
      layerHint: "ui",
      secretNames: ["PASSWORD"],
      secrets: new Map([["PASSWORD", "runtime-password"]]),
      scrub: createScrubber(["runtime-password"]),
      persist: { start, finish: vi.fn(async () => true) },
    }));

    expect(result.outcome).toBe("failed_assertion");
    // Third inspection is the confirm-before-strike re-snapshot: the fake
    // page never changes, so the fill's transition looks like no progress.
    expect(runtime.inspectCount).toBe(3);
    expect(runtime.actions[0]).toMatchObject({
      type: "ui_action",
      action: { type: "fill", value: "runtime-password" },
    });
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      safetyClass: "ui",
      request: expect.objectContaining({ value: "<not persisted>" }),
    }));
  });

  it("permits repeating an identical UI action and escalates only on no observable progress", async () => {
    // Each navigation lands on the SAME page state: an identical action with
    // an identical no-change transition. Occurrence 1 passes silently,
    // occurrence 2 returns validator feedback, occurrence 3 ends the step
    // for review — never an instant blocked_policy (V1-1).
    const staleSnapshot = { text: '- heading "Orders" [ref=e2]', url: "https://app.example.test/orders" };
    const observations: LayerRuntimeObservation[] = Array.from({ length: 4 }, () => ({
      status: "ok" as const,
      summary: "Navigation completed",
      durationMs: 1,
      uiSnapshot: staleSnapshot,
    }));
    const runtime = new FakeRuntime(new Set(["ui"]), observations);
    runtime.inspectUi = async () => {
      runtime.inspectCount += 1;
      return staleSnapshot;
    };
    const navigate = {
      decision: "act",
      actionType: "navigate",
      url: "https://app.example.test/orders",
    };

    const result = await runMultiLayerStep(input(runtime, [navigate, navigate, navigate, navigate], { layerHint: "ui" }));

    expect(result.outcome).toBe("needs_review");
    expect(result.reason).toContain("without any observable page change");
    // Repeats are executed (not hard-blocked); the guard ends the loop after
    // the third identical no-change transition.
    expect(runtime.actions).toHaveLength(3);
  });

  it("executes an API-only step without inspecting or starting UI", async () => {
    const runtime = new FakeRuntime(new Set(["api"]), [{ status: "ok", summary: "HTTP 200 ready", durationMs: 2, data: { status: "ready" } }]);
    const result = await runMultiLayerStep(input(runtime, [
      { decision: "act", actionType: "api_request", argumentsJson: JSON.stringify({ method: "GET", path: "/orders/42" }) },
      { decision: "step_passed", actualResult: "GET /orders/42 returned ready" },
    ]));
    expect(result.outcome).toBe("passed");
    expect(runtime.inspectCount).toBe(0);
    expect(runtime.actions).toHaveLength(1);
    expect(result.observedLayers).toEqual(["api"]);
  });

  it("stops before calling the model when canceled, expired, or out of AI budget", async () => {
    const runtime = new FakeRuntime(new Set(["api"]), []);
    const canceled = new AbortController();
    canceled.abort();
    await expect(runMultiLayerStep(input(runtime, [], {
      signal: canceled.signal,
    }))).rejects.toThrow("Execution aborted");

    const noBudgetProvider = provider([]);
    const noBudget = await runMultiLayerStep(input(runtime, [], {
      provider: noBudgetProvider,
      llmCallBudget: { remaining: 0 },
    }));
    expect(noBudget).toMatchObject({ outcome: "needs_review", iterations: 0 });
    expect(noBudget.reason).toContain("AI call budget");
    expect(noBudgetProvider.generateStructuredOutput).not.toHaveBeenCalled();

    const now = vi.spyOn(Date, "now")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(180_001);
    try {
      const expired = await runMultiLayerStep(input(runtime, []));
      expect(expired).toMatchObject({ outcome: "needs_review", iterations: 0 });
      expect(expired.reason).toContain("time budget");
    } finally {
      now.mockRestore();
    }
  });

  it("returns infrastructure_error after consecutive model failures", async () => {
    const llm = provider([]);
    vi.mocked(llm.generateStructuredOutput)
      .mockRejectedValueOnce(new Error("provider unavailable"))
      .mockRejectedValueOnce("non-error rejection");

    const result = await runMultiLayerStep(input(new FakeRuntime(new Set(["api"]), []), [], {
      provider: llm,
    }));

    expect(result.outcome).toBe("infrastructure_error");
    expect(result.actionsTaken).toEqual([
      expect.objectContaining({ actionType: "model", detail: "provider unavailable" }),
      expect.objectContaining({ actionType: "model", detail: "Model call failed." }),
    ]);
  });

  it("records the inferred layer for repeatedly invalid model actions", async () => {
    const invalid = { decision: "act", actionType: "db_unsupported", argumentsJson: "{}" };
    const result = await runMultiLayerStep(input(new FakeRuntime(new Set(["db"]), []), [invalid, invalid]));

    expect(result.outcome).toBe("needs_review");
    expect(result.actionsTaken).toEqual([
      expect.objectContaining({ layer: "db", result: "rejected" }),
      expect.objectContaining({ layer: "db", result: "rejected" }),
    ]);
  });

  it("requires two observed layers before a Mixed step passes", async () => {
    const runtime = new FakeRuntime(new Set(["api", "db"]), [
      { status: "ok", summary: "HTTP 200", durationMs: 1 },
      { status: "ok", summary: "one row", durationMs: 1, dbRows: [{ id: 42 }] },
    ]);
    const result = await runMultiLayerStep(input(runtime, [
      { decision: "act", actionType: "api_request", argumentsJson: JSON.stringify({ method: "GET", path: "/orders/42" }) },
      { decision: "step_passed", actualResult: "API passed" },
      { decision: "act", actionType: "db_select", argumentsJson: JSON.stringify({ sql: "SELECT id FROM orders WHERE id=:id", parameters: { id: 42 } }) },
      { decision: "step_passed", actualResult: "API and DB agree" },
    ], { layerHint: "mixed" }));
    expect(result.outcome).toBe("passed");
    expect(result.observedLayers.sort()).toEqual(["api", "db"]);
  });

  it("persists intent before execution and finalizes bounded evidence", async () => {
    const events: string[] = [];
    const runtime = new FakeRuntime(new Set(["api"]), [{ status: "ok", summary: "HTTP 200", durationMs: 1 }]);
    const result = await runMultiLayerStep(input(runtime, [
      { decision: "act", actionType: "api_request", argumentsJson: JSON.stringify({ method: "GET", path: "/orders/42" }) },
      { decision: "step_passed", actualResult: "done" },
    ], {
      persist: {
        start: vi.fn(async () => { events.push("start"); return "action-1"; }),
        finish: vi.fn(async () => { events.push("finish"); return true; }),
      },
    }));
    expect(result.outcome).toBe("passed");
    expect(events).toEqual(["start", "finish"]);
  });

  it.each([
    {
      name: "an uncertain transport result",
      observations: [{ status: "uncertain", category: "transport", summary: "Outcome unknown", durationMs: 1 }],
      outcome: "needs_review",
      finishCategory: "uncertain_side_effect",
    },
    {
      name: "a repeated identical policy block",
      observations: [
        { status: "blocked", category: "policy", summary: "Rule denied", durationMs: 1 },
        { status: "blocked", category: "policy", summary: "Rule denied", durationMs: 1 },
      ],
      outcome: "blocked_policy",
      finishCategory: "blocked_policy",
    },
    {
      name: "a prerequisite block",
      observations: [{ status: "blocked", category: "prerequisite", summary: "Credential missing", durationMs: 1 }],
      outcome: "blocked_prerequisite",
      finishCategory: "blocked_prerequisite",
    },
    {
      name: "two consecutive timeouts",
      observations: [
        { status: "failed", category: "timeout", summary: "Timed out once", durationMs: 1 },
        { status: "failed", category: "timeout", summary: "Timed out twice", durationMs: 1 },
      ],
      outcome: "timeout",
      finishCategory: "timeout",
    },
    {
      name: "two consecutive transport failures",
      observations: [
        { status: "failed", category: "transport", summary: "Socket reset", durationMs: 1 },
        { status: "failed", category: "transport", summary: "Socket reset again", durationMs: 1 },
      ],
      outcome: "needs_review",
      finishCategory: "infrastructure",
    },
    {
      name: "two consecutive action failures",
      observations: [
        { status: "failed", category: "action", summary: "Assertion mismatch", durationMs: 1 },
        { status: "failed", category: "action", summary: "Still mismatched", durationMs: 1 },
      ],
      outcome: "needs_review",
      finishCategory: "assertion",
    },
  ] as Array<{
    name: string;
    observations: LayerRuntimeObservation[];
    outcome: string;
    finishCategory: string;
  }>)("maps $name to a conservative run outcome and ledger category", async ({ observations, outcome, finishCategory }) => {
    const runtime = new FakeRuntime(new Set(["api"]), [...observations]);
    const action = {
      decision: "act",
      actionType: "api_request",
      argumentsJson: JSON.stringify({ method: "GET", path: "/orders/42" }),
    };
    const finish = vi.fn(async (entry: { observation?: { data?: unknown } }) => {
      void entry;
      return true;
    });
    let sequence = 0;

    const result = await runMultiLayerStep(input(runtime, observations.map(() => action), {
      persist: {
        start: vi.fn(async () => `action-${++sequence}`),
        finish,
      },
    }));

    expect(result.outcome).toBe(outcome);
    expect(finish).toHaveBeenLastCalledWith(expect.objectContaining({
      errorCategory: finishCategory,
    }));
  });

  it("marks a thrown mutation outcome uncertain and never retries it", async () => {
    const capability = { id: "create", name: "create", layer: "api" as const, safetyClass: "mutation" as const, approved: true, parameterSchema: {}, definition: {} };
    const runtime = new FakeRuntime(new Set(["api"]), []);
    runtime.execute = vi.fn(async () => { throw new Error("connection dropped"); });
    const finish = vi.fn(async () => true);
    const result = await runMultiLayerStep(input(runtime, [
      { decision: "act", actionType: "api_execute_operation", argumentsJson: JSON.stringify({ operationId: "create" }) },
    ], {
      capabilities: [capability],
      persist: { start: vi.fn(async () => "action-1"), finish },
    }));
    expect(result.outcome).toBe("needs_review");
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({ status: "uncertain", errorCategory: "uncertain_side_effect" }));
    expect(runtime.execute).toHaveBeenCalledTimes(1);
  });

  it("validates resolved operation parameters before persisting or executing", async () => {
    const capability = {
      id: "lookup",
      name: "Lookup order",
      layer: "api" as const,
      safetyClass: "read" as const,
      approved: true,
      parameterSchema: {
        type: "object",
        properties: { orderId: { type: "string", minLength: 1 } },
        required: ["orderId"],
        additionalProperties: false,
      },
      definition: { method: "GET", path: "/orders/{orderId}" },
    };
    const runtime = new FakeRuntime(new Set(["api"]), [{ status: "ok", summary: "HTTP 200", durationMs: 1 }]);
    const start = vi.fn(async () => "action-1");
    const result = await runMultiLayerStep(input(runtime, [
      { decision: "act", actionType: "api_execute_operation", argumentsJson: JSON.stringify({ operationId: "lookup", parameters: { orderId: 42 } }) },
      { decision: "act", actionType: "api_execute_operation", argumentsJson: JSON.stringify({ operationId: "lookup", parameters: { orderId: "42" } }) },
      { decision: "step_passed", actualResult: "Order returned" },
    ], {
      capabilities: [capability],
      persist: { start, finish: vi.fn(async () => true) },
    }));

    expect(result.outcome).toBe("passed");
    expect(result.actionsTaken[0]).toMatchObject({ result: "rejected" });
    expect(start).toHaveBeenCalledTimes(1);
    expect(runtime.actions).toHaveLength(1);
  });

  it("stops immediately when the action ledger fence is lost", async () => {
    const runtime = new FakeRuntime(new Set(["api"]), [{ status: "ok", summary: "HTTP 200", durationMs: 1 }]);
    await expect(runMultiLayerStep(input(runtime, [
      { decision: "act", actionType: "api_request", argumentsJson: JSON.stringify({ method: "GET", path: "/orders/42" }) },
    ], {
      persist: {
        start: vi.fn(async () => "action-1"),
        finish: vi.fn(async () => false),
      },
    }))).rejects.toThrow("no longer owns");
  });

  it("does not execute when the ledger cannot create an action intent", async () => {
    const runtime = new FakeRuntime(new Set(["api"]), []);
    await expect(runMultiLayerStep(input(runtime, [
      { decision: "act", actionType: "api_request", argumentsJson: JSON.stringify({ method: "GET", path: "/orders/42" }) },
    ], {
      persist: {
        start: vi.fn(async () => null),
        finish: vi.fn(async () => true),
      },
    }))).rejects.toThrow("no longer owns");
    expect(runtime.actions).toHaveLength(0);
  });

  it("stops when a thrown read failure cannot be fenced in the ledger", async () => {
    const runtime = new FakeRuntime(new Set(["api"]), []);
    runtime.execute = vi.fn(async () => { throw new Error("read transport failed"); });
    await expect(runMultiLayerStep(input(runtime, [
      { decision: "act", actionType: "api_request", argumentsJson: JSON.stringify({ method: "GET", path: "/orders/42" }) },
    ], {
      persist: {
        start: vi.fn(async () => "action-1"),
        finish: vi.fn(async () => false),
      },
    }))).rejects.toThrow("no longer owns");
    expect(runtime.execute).toHaveBeenCalledOnce();
  });

  it("rejects sensitive capture substitution before an external action executes", async () => {
    const captures = new CaseCaptureStore();
    captures.captureJson({
      name: "accessToken",
      pointer: "/auth/access_token",
      document: { auth: { access_token: "runtime-token" } },
      sensitive: false,
    });
    const runtime = new FakeRuntime(new Set(["api"]), []);
    const capability = {
      id: "lookup",
      name: "Lookup order",
      layer: "api" as const,
      safetyClass: "read" as const,
      approved: true,
      parameterSchema: {
        type: "object",
        properties: { key: { type: "string" } },
        required: ["key"],
        additionalProperties: false,
      },
      definition: { method: "GET", path: "/orders/{key}" },
    };
    const decision = {
      decision: "act",
      actionType: "api_execute_operation",
      argumentsJson: JSON.stringify({
        operationId: "lookup",
        parameters: { key: "{{capture:accessToken}}" },
      }),
    };

    const result = await runMultiLayerStep(input(runtime, [decision, decision], {
      captures,
      capabilities: [capability],
    }));

    expect(result.outcome).toBe("needs_review");
    expect(result.reason).toContain("cannot be substituted");
    expect(result.actionsTaken).toEqual([
      expect.objectContaining({ result: "rejected" }),
      expect.objectContaining({ result: "rejected" }),
    ]);
    expect(runtime.actions).toHaveLength(0);
  });

  it("learns sensitive captures and scrubs them plus JSON-escaped static secrets from prompts and persistence", async () => {
    const dynamicSecret = "runtime\"secret\nvalue";
    const staticSecret = "static\"secret\nvalue";
    const llm = provider([
      {
        decision: "act",
        actionType: "api_request",
        argumentsJson: JSON.stringify({
          method: "GET",
          path: "/orders/42",
          captures: [{ name: "capturedValue", pointer: "/auth/access_token", sensitive: false }],
        }),
      },
      { decision: "step_passed", actualResult: `Observed ${dynamicSecret}` },
    ]);
    const runtime = new FakeRuntime(new Set(["api"]), [{
      status: "ok",
      summary: `HTTP 200 returned ${dynamicSecret}`,
      durationMs: 1,
      data: { echoed: dynamicSecret, staticEcho: staticSecret },
      apiBody: { auth: { access_token: dynamicSecret } },
    }]);
    const finish = vi.fn(async () => true);

    const result = await runMultiLayerStep(input(runtime, [], {
      provider: llm,
      executionNotes: `Provider escaped value: ${JSON.stringify(staticSecret).slice(1, -1)}`,
      secrets: new Map([["STATIC", staticSecret]]),
      secretNames: ["STATIC"],
      scrub: createScrubber(buildScrubValues(new Map([["STATIC", staticSecret]]))),
      persist: { start: vi.fn(async () => "action-1"), finish },
    }));

    const prompts = vi.mocked(llm.generateStructuredOutput).mock.calls
      .map(([request]) => request.user)
      .join("\n");
    const persisted = JSON.stringify(finish.mock.calls);
    expect(result.outcome).toBe("passed");
    expect(prompts).toContain(REDACTION_MARKER);
    expect(prompts).not.toContain(dynamicSecret);
    expect(prompts).not.toContain(JSON.stringify(dynamicSecret).slice(1, -1));
    expect(prompts).not.toContain(JSON.stringify(staticSecret).slice(1, -1));
    expect(persisted).not.toContain(dynamicSecret);
    expect(persisted).not.toContain(JSON.stringify(dynamicSecret).slice(1, -1));
    expect(result.actualResult).toBe(`Observed ${REDACTION_MARKER}`);
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({
      observation: expect.objectContaining({
        captures: [expect.objectContaining({ name: "capturedValue", value: "<redacted>", sensitive: true })],
      }),
    }));
  });

  it("captures a database column for later case steps", async () => {
    const captures = new CaseCaptureStore();
    const runtime = new FakeRuntime(new Set(["db"]), [{
      status: "ok",
      summary: "one order returned",
      durationMs: 1,
      dbRows: [{ id: 42, status: "ready" }],
    }]);
    const result = await runMultiLayerStep(input(runtime, [
      {
        decision: "act",
        actionType: "db_select",
        argumentsJson: JSON.stringify({
          sql: "SELECT id, status FROM public.orders WHERE id=:id",
          parameters: { id: 42 },
          captures: [{ name: "orderId", column: "id" }],
        }),
      },
      { decision: "step_passed", actualResult: "Database order is ready" },
    ], { layerHint: "db", captures }));

    expect(result.outcome).toBe("passed");
    expect(captures.persistable()).toEqual([
      expect.objectContaining({ name: "orderId", value: 42, sourceLayer: "db" }),
    ]);
  });

  it("reports capture failures to the model without repeating a successful external read", async () => {
    const llm = provider([
      {
        decision: "act",
        actionType: "api_request",
        argumentsJson: JSON.stringify({
          method: "GET",
          path: "/orders/42",
          captures: [{ name: "orderId", pointer: "/id" }],
        }),
      },
      { decision: "step_passed", actualResult: "HTTP response itself was sufficient" },
    ]);
    const runtime = new FakeRuntime(new Set(["api"]), [{
      status: "ok",
      summary: "HTTP 204",
      durationMs: 1,
    }]);

    const result = await runMultiLayerStep(input(runtime, [], { provider: llm }));

    expect(result.outcome).toBe("passed");
    expect(result.actionsTaken).toEqual([
      expect.objectContaining({ result: "failed", detail: "HTTP 204" }),
    ]);
    const retryPrompt = vi.mocked(llm.generateStructuredOutput).mock.calls[1]?.[0].user ?? "";
    expect(retryPrompt).toContain("captures failed");
    expect(retryPrompt).toContain("no structured body");
    expect(runtime.actions).toHaveLength(1);
  });

  it("bounds unsafe observation data and retains only the six newest observations", async () => {
    const circular: Record<string, unknown> = { label: "circular" };
    circular.self = circular;
    const observations: LayerRuntimeObservation[] = Array.from({ length: 7 }, (_, index) => ({
      status: "ok",
      summary: `observation-${index}`,
      durationMs: 1,
      data: index === 0
        ? { payload: "x".repeat(9_000) }
        : index === 1
          ? circular
          : { index, nested: [index, { ok: true }] },
    }));
    const action = {
      decision: "act",
      actionType: "api_request",
      argumentsJson: JSON.stringify({ method: "GET", path: "/orders/42" }),
    };
    const llm = provider([
      ...observations.map(() => action),
      { decision: "step_passed", actualResult: "Latest evidence is sufficient" },
    ]);
    const finish = vi.fn(async (entry: { observation?: { data?: unknown } }) => {
      void entry;
      return true;
    });

    const result = await runMultiLayerStep(input(new FakeRuntime(new Set(["api"]), observations), [], {
      provider: llm,
      persist: {
        start: vi.fn(async ({ orderIndex }) => `action-${orderIndex}`),
        finish,
      },
    }));

    expect(result.outcome).toBe("passed");
    expect(finish.mock.calls[0]?.[0].observation?.data).toContain("truncated");
    expect(finish.mock.calls[1]?.[0].observation?.data).toBe("[object Object]");
    const finalPrompt = vi.mocked(llm.generateStructuredOutput).mock.calls[7]?.[0].user ?? "";
    expect(finalPrompt).not.toContain("observation-0");
    expect(finalPrompt).toContain("observation-6");
  });

  it("rejects a verdict that has no observation from any layer", async () => {
    const runtime = new FakeRuntime(new Set(["api"]), []);
    const result = await runMultiLayerStep(input(runtime, [
      { decision: "step_passed", actualResult: "Invented success" },
      { decision: "step_passed", actualResult: "Still invented" },
    ]));
    expect(result.outcome).toBe("needs_review");
    expect(result.reason).toContain("Observe at least one");
    expect(runtime.actions).toHaveLength(0);
  });

  it.each([
    ["ui", "Inspect the UI"],
    ["api", "Execute an API"],
    ["db", "query the database"],
  ] as const)("requires evidence from the explicitly requested %s layer", async (layerHint, message) => {
    const result = await runMultiLayerStep(input(new FakeRuntime(new Set(["api", "db"]), []), [
      { decision: "step_passed", actualResult: "Unsupported verdict" },
      { decision: "step_passed", actualResult: "Still unsupported" },
    ], { layerHint }));

    expect(result.outcome).toBe("needs_review");
    expect(result.reason).toContain(message);
  });

  it("includes bounded operator context, users, prior steps, secret titles, and captures in the prompt", async () => {
    const captures = new CaseCaptureStore();
    captures.captureJson({ name: "orderId", pointer: "/id", document: { id: 42 } });
    const llm = provider([{ decision: "blocked", reason: "Context inspected" }]);

    await runMultiLayerStep(input(new FakeRuntime(new Set(["api"]), []), [], {
      provider: llm,
      expectedResult: "",
      allowedOrigin: undefined,
      priorStepsSummary: ["Step 1 passed"],
      executionNotes: "Use the secondary account",
      secretNames: ["ACCOUNT_PASSWORD"],
      secretTitles: new Map([["ACCOUNT_PASSWORD", "Secondary password"]]),
      testUsers: [
        { handle: "secondary", username: "qa@example.test", passwordPlaceholder: "{{secret:ACCOUNT_PASSWORD}}", notes: "read-only" },
        { handle: "guest", username: "guest@example.test", passwordPlaceholder: null },
      ],
      captures,
    }));

    const prompt = vi.mocked(llm.generateStructuredOutput).mock.calls[0]?.[0].user ?? "";
    expect(prompt).toContain("Expected result: (none)");
    expect(prompt).toContain("ACCOUNT_PASSWORD (Secondary password)");
    expect(prompt).toContain("secondary: qa@example.test");
    expect(prompt).toContain("guest: guest@example.test, password (none)");
    expect(prompt).toContain("Step 1 passed");
    expect(prompt).toContain("orderId=42");
    // An API run with no contract and no named endpoints must not be told
    // its capabilities are "(none)" — the model reads that as an unusable
    // layer and reports the step blocked.
    expect(prompt).not.toContain("Approved operation capabilities");
    expect(prompt).not.toContain("Offered operations");
  });

  it("fingerprints the resolved mutation: alias replays get feedback, persistence ends the step", async () => {
    const captures = new CaseCaptureStore();
    captures.captureJson({ name: "orderId", pointer: "/id", document: { id: 42 } });
    const capability = {
      id: "update",
      name: "Update order",
      layer: "api" as const,
      safetyClass: "mutation" as const,
      approved: true,
      parameterSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
      definition: { method: "POST", path: "/orders/{id}" },
    };
    const runtime = new FakeRuntime(new Set(["api"]), [{ status: "ok", summary: "HTTP 200", durationMs: 1 }]);
    const result = await runMultiLayerStep(input(runtime, [
      // Executed once via the capture alias; the literal 42 resolves to the
      // SAME mutation. First replay → validator feedback; proposing it again
      // without intervening progress → needs_review (never blocked_policy).
      { decision: "act", actionType: "api_execute_operation", argumentsJson: JSON.stringify({ operationId: "update", parameters: { id: "{{capture:orderId}}" } }) },
      { decision: "act", actionType: "api_execute_operation", argumentsJson: JSON.stringify({ operationId: "update", parameters: { id: 42 } }) },
      { decision: "act", actionType: "api_execute_operation", argumentsJson: JSON.stringify({ operationId: "update", parameters: { id: 42 } }) },
    ], {
      captures,
      capabilities: [capability],
    }));
    expect(result.outcome).toBe("needs_review");
    expect(result.reason).toContain("replay");
    expect(runtime.actions).toHaveLength(1);
    expect(result.actionsTaken).toEqual([
      expect.objectContaining({ result: "ok" }),
      expect.objectContaining({ result: "rejected" }),
      expect.objectContaining({ result: "rejected" }),
    ]);
  });

  it("persists an ad-hoc database mutation as a mutation before dispatching it", async () => {
    const events: string[] = [];
    const runtime = new FakeRuntime(new Set(["db"]), [
      { status: "ok", summary: "UPDATE completed with 1 row(s).", durationMs: 1 },
    ]);
    const dispatch = runtime.execute.bind(runtime);
    runtime.execute = async (action) => {
      events.push("execute");
      return dispatch(action);
    };
    const start = vi.fn(async () => { events.push("start"); return "action-1"; });

    const result = await runMultiLayerStep(input(runtime, [
      {
        decision: "act",
        actionType: "db_mutate",
        argumentsJson: JSON.stringify({
          sql: "UPDATE orders SET status = :status WHERE id = :id",
          parameters: { id: 42, status: "ready" },
        }),
      },
      { decision: "step_passed", actualResult: "One order row was updated" },
    ], {
      layerHint: "db",
      persist: {
        start,
        finish: vi.fn(async () => { events.push("finish"); return true; }),
      },
    }));

    expect(result.outcome).toBe("passed");
    // Intent is durable before the statement can reach the database.
    expect(events).toEqual(["start", "execute", "finish"]);
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      layer: "db",
      actionType: "db_mutate",
      safetyClass: "mutation",
      request: expect.objectContaining({
        sql: "UPDATE orders SET status = :status WHERE id = :id",
      }),
    }));
  });

  it("fingerprints an ad-hoc mutation: the replay gets feedback, then ends the step", async () => {
    const runtime = new FakeRuntime(new Set(["db"]), [
      { status: "ok", summary: "UPDATE completed with 1 row(s).", durationMs: 1 },
    ]);
    const mutate = {
      decision: "act",
      actionType: "db_mutate",
      argumentsJson: JSON.stringify({
        sql: "UPDATE orders SET status = :status WHERE id = :id",
        parameters: { id: 42, status: "ready" },
      }),
    };

    const result = await runMultiLayerStep(input(runtime, [mutate, mutate, mutate], { layerHint: "db" }));

    expect(result.outcome).toBe("needs_review");
    expect(result.reason).toContain("replay");
    // The replay itself is never executed.
    expect(runtime.actions).toHaveLength(1);
    expect(result.actionsTaken).toEqual([
      expect.objectContaining({ actionType: "db_mutate", result: "ok" }),
      expect.objectContaining({ actionType: "db_mutate", result: "rejected" }),
      expect.objectContaining({ actionType: "db_mutate", result: "rejected" }),
    ]);
  });

  it("binds a capture used inside mutation SQL instead of splicing its value", async () => {
    const captures = new CaseCaptureStore();
    captures.captureJson({ name: "orderId", pointer: "/id", document: { id: 42 } });
    const runtime = new FakeRuntime(new Set(["db"]), [
      { status: "ok", summary: "UPDATE completed with 1 row(s).", durationMs: 1 },
    ]);

    const result = await runMultiLayerStep(input(runtime, [
      {
        decision: "act",
        actionType: "db_mutate",
        argumentsJson: JSON.stringify({
          sql: "UPDATE orders SET status = :status WHERE id = {{capture:orderId}}",
          parameters: { status: "ready" },
        }),
      },
      { decision: "step_passed", actualResult: "The order row is ready" },
    ], { layerHint: "db", captures }));

    expect(result.outcome).toBe("passed");
    expect(runtime.actions[0]).toMatchObject({
      layer: "db",
      type: "db_mutate",
      arguments: {
        sql: "UPDATE orders SET status = :status WHERE id = :capture_orderId",
        parameters: { status: "ready", capture_orderId: 42 },
      },
    });
    // The captured value never becomes SQL text.
    expect(JSON.stringify(runtime.actions[0])).not.toContain("{{capture:orderId}}");
    expect((runtime.actions[0] as { arguments: { sql: string } }).arguments.sql).not.toContain("42");
  });

  it("ranks a relevant operation into a bounded large-contract prompt", async () => {
    const capabilities: IntegrationCapability[] = Array.from({ length: 60 }, (_, index) => ({
      id: `contract:openapi.get.${String(index).padStart(16, "0")}`,
      name: `Unrelated catalog operation ${index} ${"x".repeat(400)}`,
      layer: "api" as const,
      safetyClass: "read" as const,
      approved: true,
      parameterSchema: { type: "object", properties: {}, additionalProperties: false },
      definition: { method: "GET", path: `/catalog/unrelated-${index}` },
    }));
    capabilities.push({
      id: "contract:openapi.get.ffffffffffffffff",
      name: "Lookup customer order",
      layer: "api",
      safetyClass: "read",
      approved: true,
      parameterSchema: {
        type: "object",
        properties: { orderId: { type: ["string", "null"] }, opaque: "unknown" },
        required: ["orderId"],
        additionalProperties: false,
      },
      definition: { method: "GET", path: "/orders/{orderId}" },
    });
    const llm = provider([{ decision: "blocked", reason: "done" }]);

    await runMultiLayerStep(input(new FakeRuntime(new Set(["api"]), []), [], {
      provider: llm,
      capabilities,
      instruction: "Look up customer order 42",
    }));

    const prompt = vi.mocked(llm.generateStructuredOutput).mock.calls[0]?.[0].user ?? "";
    expect(prompt).toContain("contract:openapi.get.ffffffffffffffff");
    expect(prompt).toContain("orderId!:string|null");
    expect(prompt.length).toBeLessThan(20_000);
  });
});
