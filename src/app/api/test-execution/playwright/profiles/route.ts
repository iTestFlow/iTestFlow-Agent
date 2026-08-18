import { NextResponse } from "next/server";
import { z } from "zod";

import { authErrorResponse, requireWorkflowContext } from "@/modules/credentials/scoped-resolution.service";
import { EXTRA_INSTRUCTIONS_MAX_LENGTH } from "@/modules/llm/extra-instructions";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";
import { createExecutionProfile } from "@/modules/test-execution/execution-profiles.service";
import { MAX_PROFILE_NAME_LENGTH, ProfileNameConflictError } from "@/modules/test-execution/execution-profiles.shared";
import {
  MAX_TEST_DATA_ENTRIES,
  MAX_TEST_DATA_TITLE_LENGTH,
  MAX_TEST_DATA_VALUE_LENGTH,
  TestDataResolutionError,
} from "@/modules/test-execution/execution-test-data.shared";
import { SCREENSHOT_POLICIES } from "@/modules/test-execution/screenshot-policy";

export const runtime = "nodejs";

const TitleSchema = z.string().trim().min(1).max(MAX_TEST_DATA_TITLE_LENGTH);

const TestDataEntrySchema = z.union([
  z.object({ title: TitleSchema, isSecret: z.literal(false), value: z.string().min(1).max(MAX_TEST_DATA_VALUE_LENGTH) }),
  z.object({ title: TitleSchema, isSecret: z.literal(true), value: z.string().min(1).max(MAX_TEST_DATA_VALUE_LENGTH) }),
  z.object({ title: TitleSchema, isSecret: z.literal(true), fromRunId: z.string().min(1), sourceTitle: TitleSchema.optional() }),
  z.object({ title: TitleSchema, isSecret: z.literal(true), fromProfileId: z.string().min(1), sourceTitle: TitleSchema.optional() }),
]);

const BaseUrlSchema = z.string().trim().min(1).max(2048).refine((value) => {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}, "The Base URL must start with http:// or https:// and cannot contain credentials.");

const Schema = z.object({
  scope: ProjectScopeSchema,
  name: z.string().trim().min(1).max(MAX_PROFILE_NAME_LENGTH),
  baseUrl: BaseUrlSchema.nullish(),
  executionNotes: z.string().trim().max(EXTRA_INSTRUCTIONS_MAX_LENGTH).nullish(),
  screenshotPolicy: z.enum(SCREENSHOT_POLICIES),
  testData: z.array(TestDataEntrySchema).max(MAX_TEST_DATA_ENTRIES).default([]),
});

export async function POST(request: Request) {
  const parsed = Schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    const friendly = parsed.error.issues.map((issue) => issue.message).find((message) => message.endsWith("."));
    return NextResponse.json({ error: friendly ?? "Enter a profile name and valid profile settings." }, { status: 400 });
  }
  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    const scope = await resolveProjectScope(ctx, parsed.data.scope);
    const profile = await createExecutionProfile({
      workspaceId: ctx.workspace.id,
      projectId: scope.projectId,
      userId: ctx.userId,
      name: parsed.data.name,
      baseUrl: parsed.data.baseUrl || null,
      executionNotes: parsed.data.executionNotes || null,
      screenshotPolicy: parsed.data.screenshotPolicy,
      testData: parsed.data.testData,
    });
    return NextResponse.json({ profile }, { status: 201 });
  } catch (error) {
    if (error instanceof ProfileNameConflictError || error instanceof TestDataResolutionError) {
      const friendly = error.message;
      return NextResponse.json({ error: friendly }, { status: error instanceof ProfileNameConflictError ? 409 : 422 });
    }
    return authErrorResponse(error) ?? NextResponse.json({ error: "The execution profile could not be saved." }, { status: 503 });
  }
}
