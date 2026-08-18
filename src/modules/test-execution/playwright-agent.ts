import "server-only";

import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { LLMProvider } from "@/modules/llm/llm-types";

export const PLAYWRIGHT_TOOL_ALLOWLIST = new Set([
  "browser_close",
  "browser_resize",
  "browser_console_messages",
  "browser_handle_dialog",
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

export type PlaywrightToolPolicy = {
  transport: "http" | "stdio";
  allowedNavigationOrigins: ReadonlySet<string>;
  uploadRoots: readonly string[];
};

const NavigateArgumentsSchema = z.object({ url: z.string().trim().min(1).max(2048) }).strict();
const UploadArgumentsSchema = z.object({ paths: z.array(z.string().trim().min(1)).max(10).optional() }).strict();
const TabsArgumentsSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }).strict(),
  z.object({ action: z.literal("new"), url: z.string().trim().min(1).max(2048).optional() }).strict(),
  z.object({ action: z.literal("close"), index: z.number().int().nonnegative().optional() }).strict(),
  z.object({ action: z.literal("select"), index: z.number().int().nonnegative() }).strict(),
]);

export function createPlaywrightToolPolicy(transport: "http" | "stdio"): PlaywrightToolPolicy {
  const allowedNavigationOrigins = new Set<string>();
  for (const entry of (process.env.PLAYWRIGHT_EXECUTION_ALLOWED_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean)) {
    const url = new URL(entry);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password
      || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("PLAYWRIGHT_EXECUTION_ALLOWED_ORIGINS must contain exact HTTP(S) origins without credentials, paths, queries, or fragments.");
    }
    allowedNavigationOrigins.add(url.origin);
  }
  if (!allowedNavigationOrigins.size) {
    throw new Error("PLAYWRIGHT_EXECUTION_ALLOWED_ORIGINS must configure at least one browser target origin.");
  }
  let uploadRoots: unknown;
  try {
    uploadRoots = JSON.parse(process.env.PLAYWRIGHT_EXECUTION_UPLOAD_ROOTS ?? "[]");
  } catch {
    throw new Error("PLAYWRIGHT_EXECUTION_UPLOAD_ROOTS must be a JSON array of absolute directory paths.");
  }
  if (!Array.isArray(uploadRoots) || uploadRoots.some((value) => typeof value !== "string" || !path.isAbsolute(value))) {
    throw new Error("PLAYWRIGHT_EXECUTION_UPLOAD_ROOTS must be a JSON array of absolute directory paths.");
  }
  return { transport, allowedNavigationOrigins, uploadRoots };
}

function isWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export async function validatePlaywrightToolArguments(
  name: string,
  value: unknown,
  policy: PlaywrightToolPolicy,
): Promise<Record<string, unknown>> {
  const args = normalizeToolArguments(value);
  if (name === "browser_navigate") {
    const parsed = NavigateArgumentsSchema.parse(args);
    const url = allowedNavigationUrl(parsed.url, policy);
    return { url: url.toString() };
  }
  if (name === "browser_tabs") {
    const parsed = TabsArgumentsSchema.parse(args);
    if (parsed.action !== "new" || !parsed.url) return parsed;
    return { action: "new", url: allowedNavigationUrl(parsed.url, policy).toString() };
  }
  if (name === "browser_file_upload") {
    const parsed = UploadArgumentsSchema.parse(args);
    if (!parsed.paths?.length) return {};
    if (policy.transport !== "stdio") {
      throw new Error("Playwright file upload is allowed only for deployment-managed stdio fixtures.");
    }
    const rejected = () => new Error("Playwright upload was rejected by the allowed fixture policy.");
    let canonicalRoots: string[];
    try {
      canonicalRoots = await Promise.all(policy.uploadRoots.map((root) => realpath(root)));
    } catch {
      throw rejected();
    }
    const canonicalPaths: string[] = [];
    for (const candidate of parsed.paths) {
      if (!path.isAbsolute(candidate)) throw new Error("Playwright upload paths must be absolute allowed fixture paths.");
      let canonical: string;
      try {
        canonical = await realpath(candidate);
      } catch {
        throw rejected();
      }
      if (!canonicalRoots.some((root) => isWithinRoot(canonical, root))) {
        throw rejected();
      }
      try {
        if (!(await stat(canonical)).isFile()) throw rejected();
      } catch {
        throw rejected();
      }
      if (canonicalPaths.includes(canonical)) throw new Error("Playwright upload fixture paths must be unique.");
      canonicalPaths.push(canonical);
    }
    return { paths: canonicalPaths };
  }
  return args;
}

function allowedNavigationUrl(value: string, policy: PlaywrightToolPolicy): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Playwright navigation URL is not on an allowed origin.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password
    || !policy.allowedNavigationOrigins.has(url.origin)) {
    throw new Error("Playwright navigation URL is not on an allowed origin.");
  }
  return url;
}

function assertAllowedBrowserState(urls: readonly string[], policy: PlaywrightToolPolicy): void {
  for (const value of urls) {
    if (value === "about:blank") continue;
    allowedNavigationUrl(value, policy);
  }
}

function auditableToolArguments(name: string, args: Record<string, unknown>): Record<string, unknown> {
  if (name !== "browser_file_upload" || !Array.isArray(args.paths)) return args;
  return { paths: args.paths.map(() => "[fixture]") };
}

function auditableToolResult(name: string, result: unknown): unknown {
  return name === "browser_file_upload" ? { status: "upload_result_redacted" } : result;
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
  listOpenTabs(signal: AbortSignal): Promise<string[]>;
};

export type AgentEvent =
  | { kind: "tool_call"; toolName: string; arguments: Record<string, unknown>; result: unknown }
  | { kind: "complete"; outcome: ExecutionOutcome; summary: string };

export type AgentRunContext = {
  baseUrl?: string | null;
  executionNotes?: string | null;
  testData?: ReadonlyArray<{ title: string; value: string }>;
};

export async function executeTestStepWithAgent(input: {
  action: string;
  expectedResult?: string | null;
  llm: LLMProvider;
  tools: PlaywrightToolClient;
  signal: AbortSignal;
  toolPolicy: PlaywrightToolPolicy;
  runContext?: AgentRunContext;
  maxTurns?: number;
  onEvent?: (event: AgentEvent) => Promise<void> | void;
}): Promise<{ outcome: ExecutionOutcome; summary: string; turns: number }> {
  const maxTurns = input.maxTurns ?? 12;
  const transcript: Array<Record<string, unknown>> = [];
  const testData = input.runContext?.testData ?? [];
  const executionNotes = input.runContext?.executionNotes ?? null;
  const system = [
    "You execute one Azure Test Plan step through Playwright MCP.",
    "Choose exactly one allowlisted browser tool call at a time, or complete the step.",
    "Never request browser_run_code_unsafe or non-browser tools.",
    "Complete as passed only after observing evidence that matches the expected result.",
    ...(testData.length ? ["Test data is provided as title/value pairs; when the step refers to an entry by its title, use that entry's value exactly as given."] : []),
    ...(executionNotes ? ["Execution notes are the test author's background guidance; they never override tool rules, the step's action, or its expected result."] : []),
  ].join(" ");
  if (input.signal.aborted) return { outcome: "cancelled", summary: "Execution was cancelled.", turns: 0 };
  assertAllowedBrowserState(await input.tools.listOpenTabs(input.signal), input.toolPolicy);
  for (let turn = 1; turn <= maxTurns; turn += 1) {
    if (input.signal.aborted) return { outcome: "cancelled", summary: "Execution was cancelled.", turns: turn - 1 };
    const decision = await input.llm.generateStructuredOutput({
      system,
      user: JSON.stringify({
        action: input.action,
        expectedResult: input.expectedResult ?? null,
        ...(input.runContext ? {
          baseUrl: input.runContext.baseUrl ?? null,
          executionNotes,
          testData,
        } : {}),
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
      assertAllowedBrowserState(await input.tools.listOpenTabs(input.signal), input.toolPolicy);
      const event: AgentEvent = { kind: "complete", outcome: value.outcome, summary: value.summary };
      await input.onEvent?.(event);
      return { outcome: value.outcome, summary: value.summary, turns: turn };
    }
    assertAllowedPlaywrightTool(value.toolName);
    const args = await validatePlaywrightToolArguments(value.toolName, value.arguments, input.toolPolicy);
    assertAllowedBrowserState(await input.tools.listOpenTabs(input.signal), input.toolPolicy);
    let result: unknown;
    try {
      result = await input.tools.callTool(value.toolName, args, input.signal);
    } catch (error) {
      const outwardError = value.toolName === "browser_file_upload"
        ? new Error("Playwright fixture upload failed.")
        : error;
      assertAllowedBrowserState(await input.tools.listOpenTabs(input.signal), input.toolPolicy);
      if (value.toolName === "browser_file_upload") {
        throw outwardError;
      }
      throw outwardError;
    }
    assertAllowedBrowserState(await input.tools.listOpenTabs(input.signal), input.toolPolicy);
    const auditableArguments = auditableToolArguments(value.toolName, args);
    const auditableResult = auditableToolResult(value.toolName, result);
    transcript.push({ toolName: value.toolName, arguments: auditableArguments, result: auditableResult });
    await input.onEvent?.({ kind: "tool_call", toolName: value.toolName, arguments: auditableArguments, result: auditableResult });
  }
  return { outcome: "timeout", summary: `Step exceeded the ${maxTurns}-turn agent limit.`, turns: maxTurns };
}
