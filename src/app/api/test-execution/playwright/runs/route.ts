import { NextResponse } from "next/server";
import { z } from "zod";

import { authErrorResponse, requireWorkflowContext } from "@/modules/credentials/scoped-resolution.service";
import { EXTRA_INSTRUCTIONS_MAX_LENGTH, normalizeExtraInstructions } from "@/modules/llm/extra-instructions";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";
import { routeErrorResponse } from "@/modules/shared/errors/route-error-response";
import { createExecutionRun } from "@/modules/test-execution/execution-store.service";
import { resolveTestDataEntries } from "@/modules/test-execution/execution-test-data.service";
import {
  MAX_TEST_DATA_ENTRIES,
  MAX_TEST_DATA_TITLE_LENGTH,
  MAX_TEST_DATA_VALUE_LENGTH,
  TestDataResolutionError,
} from "@/modules/test-execution/execution-test-data.shared";
import { resolvePlaywrightMcpConfig } from "@/modules/test-execution/playwright-mcp-config.service";
import { SCREENSHOT_POLICIES } from "@/modules/test-execution/screenshot-policy";
import { hasHealthyWorkerCapability } from "@/modules/jobs/worker-registry.service";

export const runtime = "nodejs";

const TitleSchema = z.string().trim().min(1).max(MAX_TEST_DATA_TITLE_LENGTH);

const TestDataEntrySchema = z.union([
  z.object({ title: TitleSchema, isSecret: z.literal(false), value: z.string().min(1).max(MAX_TEST_DATA_VALUE_LENGTH) }),
  z.object({ title: TitleSchema, isSecret: z.literal(true), value: z.string().min(1).max(MAX_TEST_DATA_VALUE_LENGTH) }),
  z.object({ title: TitleSchema, isSecret: z.literal(true), fromRunId: z.string().min(1), sourceTitle: TitleSchema.optional() }),
  z.object({ title: TitleSchema, isSecret: z.literal(true), fromProfileId: z.string().min(1), sourceTitle: TitleSchema.optional() }),
]);

const StepSchema = z.object({
  action: z.string().trim().min(1).max(4000, "Each step is limited to 4000 characters."),
  expectedResult: z.string().trim().max(4000, "Each expected result is limited to 4000 characters.").optional(),
});

const CaseSchema = z.object({
  azureTestCaseId: z.coerce.number().int().positive().nullish(),
  azureTestPointId: z.coerce.number().int().positive().nullish(),
  azurePlanId: z.coerce.number().int().positive().nullish(),
  azureSuiteId: z.coerce.number().int().positive().nullish(),
  title: z.string().trim().min(1).max(400, "Test case titles are limited to 400 characters."),
  steps: z.array(StepSchema).min(1).max(100, "Each test case is limited to 100 steps."),
});

const Schema = z.object({
  scope: ProjectScopeSchema,
  name: z.string().trim().max(200, "Run names are limited to 200 characters.").optional(),
  baseUrl: z.string().trim().min(1).max(2048),
  executionNotes: z.string().trim().max(EXTRA_INSTRUCTIONS_MAX_LENGTH).optional(),
  screenshotPolicy: z.enum(SCREENSHOT_POLICIES),
  headless: z.boolean().default(true),
  viewportWidth: z.coerce.number().int()
    .min(320, "Viewport width must be between 320 and 3840 pixels.")
    .max(3840, "Viewport width must be between 320 and 3840 pixels.")
    .default(1920),
  viewportHeight: z.coerce.number().int()
    .min(240, "Viewport height must be between 240 and 2160 pixels.")
    .max(2160, "Viewport height must be between 240 and 2160 pixels.")
    .default(1080),
  testData: z.array(TestDataEntrySchema).max(MAX_TEST_DATA_ENTRIES, `Use at most ${MAX_TEST_DATA_ENTRIES} test data entries.`).default([]),
  planId: z.coerce.number().int().positive().nullish(),
  suiteId: z.coerce.number().int().positive().nullish(),
  cases: z.array(CaseSchema).min(1).max(200, "Runs are limited to 200 test cases."),
}).superRefine((value, ctx) => {
  for (const [index, testCase] of value.cases.entries()) {
    if (testCase.azureTestPointId && !(testCase.azureTestCaseId && testCase.azurePlanId && testCase.azureSuiteId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cases", index],
        message: "Cases with a test point must also carry their test case, plan, and suite ids.",
      });
    }
  }
});

function invalidBaseUrlMessage(baseUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return "Enter a valid Base URL starting with http:// or https://.";
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    return "Enter a valid Base URL starting with http:// or https://.";
  }
  // Best-effort pre-check when this process knows the allowlist; the worker
  // enforces the policy regardless (createPlaywrightToolPolicy).
  const configured = (process.env.PLAYWRIGHT_EXECUTION_ALLOWED_ORIGINS ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  if (configured.length) {
    try {
      const origins = new Set(configured.map((entry) => new URL(entry).origin));
      if (!origins.has(url.origin)) {
        return "The Base URL must be on one of the allowed test origins configured for this deployment.";
      }
    } catch {
      // Malformed deployment config — leave enforcement to the worker.
    }
  }
  return null;
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: string }).code === "23505");
}

export async function POST(request: Request) {
  const parsed = Schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    // Surface authored limit messages (they end with a period); everything else
    // falls back to the generic prompt.
    const friendly = parsed.error.issues.map((issue) => issue.message).find((message) => message.endsWith("."));
    return NextResponse.json({ error: friendly ?? "Provide a Base URL and at least one test case with steps." }, { status: 400 });
  }
  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    const scope = await resolveProjectScope(ctx, parsed.data.scope);
    const config = await resolvePlaywrightMcpConfig(ctx.workspace.id);
    if (!config || config.status !== "configured") {
      return NextResponse.json({ error: "A workspace owner or admin must configure and enable Playwright MCP first." }, { status: 409 });
    }
    if (!await hasHealthyWorkerCapability("playwright_mcp_execution")) {
      return NextResponse.json({ error: "No healthy worker is available for Playwright MCP execution." }, { status: 503 });
    }
    const baseUrlIssue = invalidBaseUrlMessage(parsed.data.baseUrl);
    if (baseUrlIssue) return NextResponse.json({ error: baseUrlIssue }, { status: 422 });
    let testData;
    try {
      testData = await resolveTestDataEntries({
        workspaceId: ctx.workspace.id,
        projectId: scope.projectId,
        entries: parsed.data.testData,
      });
    } catch (error) {
      if (error instanceof TestDataResolutionError) {
        const friendly = error.message;
        return NextResponse.json({ error: friendly }, { status: 422 });
      }
      throw error;
    }
    try {
      const { runId, jobId } = await createExecutionRun({
        workspaceId: ctx.workspace.id,
        projectId: scope.projectId,
        planId: parsed.data.planId ?? null,
        suiteId: parsed.data.suiteId ?? null,
        requestedByUserId: ctx.userId,
        name: parsed.data.name || null,
        settings: {
          baseUrl: parsed.data.baseUrl,
          executionNotes: normalizeExtraInstructions(parsed.data.executionNotes) || null,
          screenshotPolicy: parsed.data.screenshotPolicy,
          headless: parsed.data.headless,
          viewportWidth: parsed.data.viewportWidth,
          viewportHeight: parsed.data.viewportHeight,
        },
        testData,
        configSnapshot: { transport: config.transport, endpoint: config.endpoint, artifactBaseUrl: config.artifactBaseUrl },
        job: { userId: ctx.userId, scope },
        cases: parsed.data.cases.map((testCase) => ({
          testCaseId: testCase.azureTestCaseId ?? null,
          testPointId: testCase.azureTestPointId ?? null,
          planId: testCase.azurePlanId ?? null,
          suiteId: testCase.azureSuiteId ?? null,
          title: testCase.title,
          steps: testCase.steps,
        })),
      });
      return NextResponse.json({ runId, jobId, status: "queued", totalCases: parsed.data.cases.length }, { status: 202 });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return NextResponse.json({ error: "Another execution is already running for this project. Wait for it to finish or cancel it first." }, { status: 409 });
      }
      throw error;
    }
  } catch (error) {
    const auth = authErrorResponse(error);
    if (auth) return auth;
    return routeErrorResponse(error, { domain: "azure", status: 503, fallback: "Playwright MCP execution could not be queued." });
  }
}
