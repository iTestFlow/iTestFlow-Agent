import "server-only";

import { z } from "zod";
import type { LLMProvider, LLMToolDefinition } from "@/modules/llm/llm-types";
import type { ExecutionOutcome } from "./playwright-agent";
import type { OpenApiOperation } from "./openapi-discovery";

const tools: LLMToolDefinition[] = [
  { name: "api_request", description: "Send one HTTP request through a named API connection. Writes require connection opt-in.", inputSchema: { type: "object", properties: { alias: { type: "string" }, method: { type: "string", enum: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] }, path: { type: "string" }, query: { type: "object" }, headers: { type: "object" }, body: {}, contentType: { type: "string" } }, required: ["alias", "method", "path"] } },
  { name: "database_schema", description: "Discover account-visible schemas, tables, and columns through a named database connection.", inputSchema: { type: "object", properties: { alias: { type: "string" }, tablePattern: { type: "string" } }, required: ["alias"] } },
  { name: "database_query", description: "Execute one parameterized SELECT or opt-in mutation on a named database connection. Use :name parameters; never interpolate values into SQL.", inputSchema: { type: "object", properties: { alias: { type: "string" }, kind: { type: "string", enum: ["select", "mutation"] }, sql: { type: "string" }, parameters: { type: "object" } }, required: ["alias", "kind", "sql"] } },
  { name: "capture_value", description: "Save a scalar from latest API/DB result for later steps in this case. Use a simple path such as body.id or rows[0].id. Captured values remain private; reference them as {{capture:name}}.", inputSchema: { type: "object", properties: { name: { type: "string" }, path: { type: "string" } }, required: ["name", "path"] } },
  { name: "assert_value", description: "Deterministically compare a field in latest API/DB result. Use paths like statusCode, body.id, rowCount, or rows[0].id.", inputSchema: { type: "object", properties: { path: { type: "string" }, operator: { type: "string", enum: ["equals", "not_equals", "contains", "exists", "gte", "lte"] }, expected: {} }, required: ["path", "operator"] } },
  { name: "complete_test_step", description: "Finish step after real tool evidence. Passing API/DB step with expected result also requires successful assert_value.", inputSchema: { type: "object", properties: { outcome: { type: "string", enum: ["passed", "failed", "blocked", "error"] }, summary: { type: "string" } }, required: ["outcome", "summary"] } },
];

export const ApiRequestArguments = z.object({ alias: z.string().min(1), method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]), path: z.string().min(1), query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(), headers: z.record(z.string(), z.string()).optional(), body: z.unknown().optional(), contentType: z.enum(["application/json", "text/plain", "application/x-www-form-urlencoded"]).optional() }).strict();
export const DatabaseSchemaArguments = z.object({ alias: z.string().min(1), tablePattern: z.string().optional() }).strict();
export const DatabaseQueryArguments = z.object({ alias: z.string().min(1), kind: z.enum(["select", "mutation"]), sql: z.string().min(1), parameters: z.record(z.string(), z.unknown()).optional() }).strict();
export const CaptureArguments = z.object({ name: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/), path: z.string().min(1) }).strict();
export const AssertArguments = z.object({ path: z.string().min(1), operator: z.enum(["equals", "not_equals", "contains", "exists", "gte", "lte"]), expected: z.unknown().optional() }).strict();
const CompletionArguments = z.object({ outcome: z.enum(["passed", "failed", "blocked", "error"]), summary: z.string().min(1) }).strict();

export type MixedToolResult = { observation: unknown; succeeded: boolean; assertionPassed?: boolean; external?: boolean };

export async function executeMixedTestStep(input: {
  action: string;
  expectedResult?: string | null;
  notes?: string | null;
  aliases: readonly { alias: string; kind: "api" | "database"; allowWrites: boolean }[];
  captureNames: () => readonly string[];
  testDataTitles?: readonly string[];
  openApi?: Record<string, readonly OpenApiOperation[]>;
  browserTools?: readonly LLMToolDefinition[];
  llm: LLMProvider;
  signal: AbortSignal;
  executeTool: (name: string, args: Record<string, unknown>) => Promise<MixedToolResult>;
  maxTurns?: number;
}): Promise<{ outcome: ExecutionOutcome; summary: string; turns: number }> {
  const observations: unknown[] = [];
  let attempted = 0;
  let lastExternalSucceeded = false;
  let asserted = false;
  let lastExternalWasApiOrDatabase = false;
  const allowedTools = [...(input.browserTools ?? []), ...tools];
  const availableNames = new Set(allowedTools.map((tool) => tool.name));
  for (let turn = 1; turn <= (input.maxTurns ?? 14); turn += 1) {
    if (input.signal.aborted) return { outcome: "cancelled", summary: "Execution was cancelled.", turns: turn - 1 };
    const decision = await input.llm.generateToolCall({
      system: [
        "Execute one authored test step using only advertised tools. Connections and browser state persist across steps.",
        "Choose exactly one tool call per turn. Never use arbitrary code, shell, fetch, browser_run_code_unsafe, or unlisted aliases.",
        "Use exact connection alias. For database values, use named SQL parameters; never interpolate literals or captured values into SQL.",
        "Capture values by path, then reference as {{capture:name}} in later API paths, queries, bodies, or SQL parameter values. Never ask to see raw captured values.",
        "Use {{testData:title}} for named test data; values are resolved privately by worker. SQL placeholders belong in parameter values, never SQL text.",
        "Complete passed only after successful external tool evidence. When expected result exists for API/DB work, call assert_value and require a successful comparison.",
        "Tool errors do not prove success. Do not retry writes after uncertain outcomes. Keep summaries free of credentials and response values.",
        input.notes ? `Author guidance: ${input.notes}` : "",
      ].filter(Boolean).join(" "),
      user: JSON.stringify({ action: input.action, expectedResult: input.expectedResult ?? null, aliases: input.aliases, captures: input.captureNames(), testDataTitles: input.testDataTitles, openApi: input.openApi, observations }),
      tools: allowedTools,
      operationName: "MixedExecutionToolCall",
      maxTokens: 1400,
      signal: input.signal,
    });
    const { name, arguments: args } = decision.toolCall;
    if (name === "complete_test_step") {
      const completion = CompletionArguments.parse(args);
      if (completion.outcome === "passed" && (!attempted || !lastExternalSucceeded || (lastExternalWasApiOrDatabase && Boolean(input.expectedResult) && !asserted))) {
        observations.push({ tool: name, error: "Successful external evidence and required assertion are missing." });
        continue;
      }
      return { outcome: completion.outcome, summary: completion.summary, turns: turn };
    }
    if (!availableNames.has(name)) throw new Error(`Mixed execution tool "${name}" is not allowed.`);
    const result = await input.executeTool(name, args);
    if (result.external) {
      attempted += 1;
      lastExternalSucceeded = result.succeeded;
      lastExternalWasApiOrDatabase = name === "api_request" || name === "database_query" || name === "database_schema";
      if (lastExternalWasApiOrDatabase) {
        asserted = false;
      }
    }
    if (result.assertionPassed === true) { asserted = true; lastExternalSucceeded = true; }
    if (result.assertionPassed === false) asserted = false;
    observations.push({ tool: name, result: result.observation });
    if (observations.length > 12) observations.shift();
    if (result.assertionPassed === false) return { outcome: "failed", summary: "Deterministic assertion failed.", turns: turn };
  }
  return { outcome: "timeout", summary: "Step exceeded the 14-turn agent limit.", turns: input.maxTurns ?? 14 };
}
