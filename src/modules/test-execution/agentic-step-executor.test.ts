import { describe, expect, it, vi } from "vitest";

import type { LLMProvider } from "@/modules/llm/llm-types";
import { FakeBrowserExecutor } from "@/modules/integrations/browser-automation/fake-browser-executor";
import { createScrubber } from "@/modules/integrations/browser-automation/output-scrubber";

import { runAgenticStep, type AgenticStepInput } from "./agentic-step-executor";

/**
 * The loop under test with a sequenced fake provider (each entry is one model
 * turn) and the scripted fake executor. AppError-style failures are plain
 * rejects — the loop only cares that the call threw.
 */

const SNAPSHOT = '- button "Save" [ref=e1]\n- textbox "Password" [ref=e2]';

function sequencedProvider(outputs: (Record<string, unknown> | { reject: string })[]): LLMProvider {
  const generateStructuredOutput = vi.fn();
  for (const output of outputs) {
    if ("reject" in output && typeof output.reject === "string" && Object.keys(output).length === 1) {
      generateStructuredOutput.mockRejectedValueOnce(new Error(output.reject));
    } else {
      generateStructuredOutput.mockResolvedValueOnce({
        provider: "anthropic",
        model: "claude-sonnet-5",
        rawOutput: "{}",
        validatedOutput: output,
        tokenUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        warnings: [],
      });
    }
  }
  return {
    testConnection: vi.fn(),
    getTokenUsage: vi.fn(() => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0 })),
    generateText: vi.fn(),
    generateStructuredOutput,
    maxInputTokens: 100_000,
  } as unknown as LLMProvider;
}

async function startExecutor(executor: FakeBrowserExecutor, secrets = new Map<string, string>()) {
  await executor.start({
    runId: "trun_test",
    initialUrl: "https://app.example.com/login",
    allowedOrigin: "https://app.example.com",
    viewport: { width: 1280, height: 720 },
    headless: true,
    defaultTimeoutMs: 5_000,
    navigationTimeoutMs: 15_000,
    secrets,
    signal: new AbortController().signal,
  });
}

function stepInput(
  provider: LLMProvider,
  executor: FakeBrowserExecutor,
  overrides?: Partial<AgenticStepInput>,
): AgenticStepInput {
  return {
    provider,
    executor,
    caseTitle: "Case",
    stepIndex: 0,
    stepTotal: 1,
    instruction: "Save the form",
    expectedResult: "A success toast appears",
    priorStepsSummary: [],
    secretNames: [],
    secrets: new Map(),
    allowedOrigin: "https://app.example.com",
    scrub: createScrubber([]),
    signal: new AbortController().signal,
    llmCallBudget: { remaining: 50 },
    metadata: { action: "test" },
    ...overrides,
  };
}

describe("runAgenticStep", () => {
  it("acts then passes, recording an auditable transcript", async () => {
    const executor = new FakeBrowserExecutor({ snapshots: [SNAPSHOT] });
    await startExecutor(executor);
    const provider = sequencedProvider([
      { decision: "act", actionType: "click", ref: "e1", elementDescription: "Save button" },
      { decision: "step_passed", actualResult: "Toast 'Saved' is visible" },
    ]);

    const result = await runAgenticStep(stepInput(provider, executor));
    expect(result.outcome).toBe("passed");
    expect(result.actualResult).toBe("Toast 'Saved' is visible");
    expect(result.iterations).toBe(2);
    expect(result.actionsTaken).toEqual([
      expect.objectContaining({ description: 'Click Save button [e1]', result: "ok" }),
    ]);
    expect(executor.executedActions).toHaveLength(1);
  });

  it("rejects hallucinated refs with feedback and lets the model recover", async () => {
    const executor = new FakeBrowserExecutor({ snapshots: [SNAPSHOT] });
    await startExecutor(executor);
    const provider = sequencedProvider([
      { decision: "act", actionType: "click", ref: "e99", elementDescription: "ghost" },
      { decision: "act", actionType: "click", ref: "e1", elementDescription: "Save button" },
      { decision: "step_passed", actualResult: "Saved" },
    ]);

    const result = await runAgenticStep(stepInput(provider, executor));
    expect(result.outcome).toBe("passed");
    expect(result.actionsTaken[0]).toMatchObject({ result: "rejected" });
    expect(executor.executedActions).toHaveLength(1);
  });

  it("two consecutive invalid decisions end as needs_review", async () => {
    const executor = new FakeBrowserExecutor({ snapshots: [SNAPSHOT] });
    await startExecutor(executor);
    const provider = sequencedProvider([
      { decision: "act", actionType: "click", ref: "e98" },
      { decision: "act", actionType: "evaluate", ref: "e1" },
    ]);

    const result = await runAgenticStep(stepInput(provider, executor));
    expect(result.outcome).toBe("needs_review");
    expect(executor.executedActions).toHaveLength(0);
  });

  it("blocked verdicts map to blocked_prerequisite with the agent's reason", async () => {
    const executor = new FakeBrowserExecutor({ snapshots: [SNAPSHOT] });
    await startExecutor(executor);
    const provider = sequencedProvider([{ decision: "blocked", reason: "The page requires an OTP code." }]);

    const result = await runAgenticStep(stepInput(provider, executor));
    expect(result.outcome).toBe("blocked_prerequisite");
    expect(result.reason).toContain("OTP");
  });

  it("two consecutive model failures end as infrastructure_error", async () => {
    const executor = new FakeBrowserExecutor({ snapshots: [SNAPSHOT] });
    await startExecutor(executor);
    const provider = sequencedProvider([{ reject: "invalid json" }, { reject: "invalid json again" }]);

    const result = await runAgenticStep(stepInput(provider, executor));
    expect(result.outcome).toBe("infrastructure_error");
  });

  it("an exhausted run budget ends as needs_review before calling the model", async () => {
    const executor = new FakeBrowserExecutor({ snapshots: [SNAPSHOT] });
    await startExecutor(executor);
    const provider = sequencedProvider([]);

    const result = await runAgenticStep(stepInput(provider, executor, { llmCallBudget: { remaining: 0 } }));
    expect(result.outcome).toBe("needs_review");
    expect(result.reason).toContain("budget");
  });

  it("substitutes secrets after validation and keeps them out of prompts and transcripts", async () => {
    const secrets = new Map([["PASSWORD", "hunter2-value"]]);
    const executor = new FakeBrowserExecutor({ snapshots: [SNAPSHOT] });
    await startExecutor(executor, secrets);
    const provider = sequencedProvider([
      {
        decision: "act",
        actionType: "fill",
        ref: "e2",
        elementDescription: "Password field",
        value: "{{secret:PASSWORD}}",
      },
      { decision: "step_passed", actualResult: "Logged in" },
    ]);

    const result = await runAgenticStep(
      stepInput(provider, executor, {
        secretNames: ["PASSWORD"],
        secrets,
        scrub: createScrubber(["hunter2-value"]),
      }),
    );
    expect(result.outcome).toBe("passed");
    const executed = executor.executedActions[0];
    expect(executed.type === "fill" && executed.value).toBe("hunter2-value");
    expect(JSON.stringify(result.actionsTaken)).not.toContain("hunter2-value");

    // Prompts sent to the model must contain the placeholder name only.
    const calls = (provider.generateStructuredOutput as ReturnType<typeof vi.fn>).mock.calls;
    for (const [callInput] of calls) {
      expect(JSON.stringify(callInput)).not.toContain("hunter2-value");
    }
  });

  it("repeated timeouts end the step as timeout after feedback", async () => {
    const executor = new FakeBrowserExecutor({
      snapshots: [SNAPSHOT],
      actionScript: [
        { status: "failed", reason: "timeout", observation: { durationMs: 1, detail: "click timed out" } },
        { status: "failed", reason: "timeout", observation: { durationMs: 1, detail: "click timed out" } },
      ],
    });
    await startExecutor(executor);
    const provider = sequencedProvider([
      { decision: "act", actionType: "click", ref: "e1", elementDescription: "Save" },
      { decision: "act", actionType: "click", ref: "e1", elementDescription: "Save" },
    ]);

    const result = await runAgenticStep(stepInput(provider, executor));
    expect(result.outcome).toBe("timeout");
    expect(result.actionsTaken.filter((record) => record.result === "failed")).toHaveLength(2);
  });

  it("policy violations from the adapter end as blocked_policy immediately", async () => {
    const executor = new FakeBrowserExecutor({
      snapshots: [SNAPSHOT],
      actionScript: [
        {
          status: "failed",
          reason: "policy_violation",
          observation: { durationMs: 1, detail: "off-origin navigation" },
        },
      ],
    });
    await startExecutor(executor);
    const provider = sequencedProvider([
      { decision: "act", actionType: "navigate", url: "/somewhere" },
    ]);

    const result = await runAgenticStep(stepInput(provider, executor));
    expect(result.outcome).toBe("blocked_policy");
  });

  it("iteration exhaustion ends as needs_review", async () => {
    const executor = new FakeBrowserExecutor({ snapshots: [SNAPSHOT] });
    await startExecutor(executor);
    const provider = sequencedProvider(
      Array.from({ length: 10 }, () => ({
        decision: "act",
        actionType: "click",
        ref: "e1",
        elementDescription: "Save",
      })),
    );

    const result = await runAgenticStep(stepInput(provider, executor));
    expect(result.outcome).toBe("needs_review");
    expect(result.iterations).toBe(8);
  });
});
