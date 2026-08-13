import "server-only";

import { z } from "zod";
import type { LLMProvider } from "@/modules/llm/llm-types";

export const PLAYWRIGHT_TOOL_ALLOWLIST = new Set([
  "browser_close",
  "browser_resize",
  "browser_console_messages",
  "browser_handle_dialog",
  "browser_evaluate",
  "browser_file_upload",
  "browser_fill_form",
  "browser_press_key",
  "browser_type",
  "browser_navigate",
  "browser_navigate_back",
  "browser_network_requests",
  "browser_take_screenshot",
  "browser_snapshot",
  "browser_click",
  "browser_drag",
  "browser_hover",
  "browser_select_option",
  "browser_tabs",
  "browser_wait_for",
]);

export type ExecutionOutcome = "passed" | "failed" | "blocked" | "timeout" | "cancelled" | "error";

const AZURE_OUTCOMES: Record<ExecutionOutcome, string> = {
  passed: "Passed",
  failed: "Failed",
  blocked: "Blocked",
  timeout: "Timeout",
  cancelled: "Aborted",
  error: "Error",
};

export function mapExecutionOutcomeToAzure(outcome: ExecutionOutcome): string {
  return AZURE_OUTCOMES[outcome];
}

export function assertAllowedPlaywrightTool(name: string): void {
  if (!PLAYWRIGHT_TOOL_ALLOWLIST.has(name)) throw new Error(`Playwright MCP tool "${name}" is not allowed.`);
}

export function normalizeToolArguments(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Playwright MCP tool arguments must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

const AgentDecisionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("tool_call"),
    toolName: z.string().min(1),
    arguments: z.record(z.string(), z.unknown()),
    reason: z.string().min(1),
  }),
  z.object({
    kind: z.literal("complete"),
    outcome: z.enum(["passed", "failed", "blocked", "error"]),
    summary: z.string().min(1),
  }),
]);

export type PlaywrightToolClient = {
  callTool(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
};

export type AgentEvent =
  | { kind: "tool_call"; toolName: string; arguments: Record<string, unknown>; result: unknown }
  | { kind: "complete"; outcome: ExecutionOutcome; summary: string };

export async function executeTestStepWithAgent(input: {
  action: string;
  expectedResult?: string | null;
  llm: LLMProvider;
  tools: PlaywrightToolClient;
  signal: AbortSignal;
  maxTurns?: number;
  onEvent?: (event: AgentEvent) => Promise<void> | void;
}): Promise<{ outcome: ExecutionOutcome; summary: string; turns: number }> {
  const maxTurns = input.maxTurns ?? 12;
  const transcript: Array<Record<string, unknown>> = [];
  for (let turn = 1; turn <= maxTurns; turn += 1) {
    if (input.signal.aborted) return { outcome: "cancelled", summary: "Execution was cancelled.", turns: turn - 1 };
    const decision = await input.llm.generateStructuredOutput({
      system: [
        "You execute one Azure Test Plan step through Playwright MCP.",
        "Choose exactly one allowlisted browser tool call at a time, or complete the step.",
        "Never request browser_run_code_unsafe or non-browser tools.",
        "Complete as passed only after observing evidence that matches the expected result.",
      ].join(" "),
      user: JSON.stringify({
        action: input.action,
        expectedResult: input.expectedResult ?? null,
        allowedTools: [...PLAYWRIGHT_TOOL_ALLOWLIST],
        observations: transcript,
      }),
      schema: AgentDecisionSchema,
      schemaName: "PlaywrightAgentDecision",
      maxTokens: 1200,
      signal: input.signal,
    });
    const value = decision.validatedOutput;
    if (value.kind === "complete") {
      const event: AgentEvent = { kind: "complete", outcome: value.outcome, summary: value.summary };
      await input.onEvent?.(event);
      return { outcome: value.outcome, summary: value.summary, turns: turn };
    }
    assertAllowedPlaywrightTool(value.toolName);
    const args = normalizeToolArguments(value.arguments);
    const result = await input.tools.callTool(value.toolName, args, input.signal);
    transcript.push({ toolName: value.toolName, arguments: args, result });
    await input.onEvent?.({ kind: "tool_call", toolName: value.toolName, arguments: args, result });
  }
  return { outcome: "timeout", summary: `Step exceeded the ${maxTurns}-turn agent limit.`, turns: maxTurns };
}
