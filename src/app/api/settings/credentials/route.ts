import { NextResponse } from "next/server";
import { z } from "zod";

import { nowIso } from "@/modules/shared/infrastructure/database/db";
import { requireSession, SessionError } from "@/modules/auth/session.service";
import { getPrimaryWorkspaceForUser } from "@/modules/workspace/workspace.service";
import { PatAuthProvider } from "@/modules/auth/pat-auth-provider";
import {
  getUserCredentialStatus,
  saveUserLlmSettings,
  storeUserAzurePat,
  storeUserLlmApiKey,
} from "@/modules/credentials/credential.service";
import { checkRateLimit, clientIp } from "@/modules/security/rate-limit";

export const runtime = "nodejs";

/**
 * "My Credentials" API. Returns only masked previews + status (never raw
 * secrets). Updates store the caller's own encrypted Azure PAT and/or LLM key,
 * validating the PAT against the workspace's Azure org first. A user can only
 * read/update their own credentials — the user is resolved from the session.
 */
async function resolveContext() {
  const session = await requireSession();
  const workspace = await getPrimaryWorkspaceForUser(session.userId);
  if (!workspace) {
    const error = new Error("No workspace membership found for this user.");
    error.name = "NoWorkspaceError";
    throw error;
  }
  return { userId: session.userId, workspace };
}

function errorResponse(error: unknown) {
  if (error instanceof SessionError) return NextResponse.json({ error: error.message }, { status: 401 });
  if (error instanceof Error && error.name === "NoWorkspaceError") {
    return NextResponse.json({ error: error.message }, { status: 403 });
  }
  throw error;
}

export async function GET() {
  let context: Awaited<ReturnType<typeof resolveContext>>;
  try {
    context = await resolveContext();
  } catch (error) {
    return errorResponse(error);
  }

  const status = await getUserCredentialStatus(context.workspace.id, context.userId);
  return NextResponse.json(
    { workspaceId: context.workspace.id, ...status },
    { headers: { "Cache-Control": "no-store" } },
  );
}

const UpdateSchema = z
  .object({
    azurePat: z.string().trim().min(1).optional(),
    llm: z
      .object({
        provider: z.enum(["openai", "gemini", "anthropic"]),
        model: z.string().trim().min(1, "Select an LLM model."),
        apiKey: z.string().trim().min(1, "Enter an LLM API key."),
        baseUrl: z.string().trim().url().optional(),
      })
      .optional(),
  })
  .refine((value) => value.azurePat || value.llm, {
    message: "Provide an Azure DevOps PAT and/or LLM credentials to update.",
  });

export async function PUT(request: Request) {
  const rate = checkRateLimit(`cred-update:${clientIp(request)}`, 20, 5 * 60 * 1000);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Please wait and try again." },
      { status: 429, headers: { "Retry-After": String(rate.retryAfterSeconds) } },
    );
  }

  let context: Awaited<ReturnType<typeof resolveContext>>;
  try {
    context = await resolveContext();
  } catch (error) {
    return errorResponse(error);
  }

  const parsed = UpdateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid credentials payload." }, { status: 400 });
  }

  if (parsed.data.azurePat) {
    try {
      await new PatAuthProvider().authenticate({
        organizationUrl: context.workspace.azureOrgUrl,
        personalAccessToken: parsed.data.azurePat,
      });
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Azure DevOps PAT validation failed." },
        { status: 422 },
      );
    }
    await storeUserAzurePat({
      workspaceId: context.workspace.id,
      userId: context.userId,
      pat: parsed.data.azurePat,
      status: "configured",
      lastValidatedAt: nowIso(),
    });
  }

  if (parsed.data.llm) {
    await storeUserLlmApiKey({
      workspaceId: context.workspace.id,
      userId: context.userId,
      provider: parsed.data.llm.provider,
      apiKey: parsed.data.llm.apiKey,
      lastValidatedAt: nowIso(),
    });
    await saveUserLlmSettings({
      workspaceId: context.workspace.id,
      userId: context.userId,
      provider: parsed.data.llm.provider,
      model: parsed.data.llm.model,
      baseUrl: parsed.data.llm.baseUrl,
      isDefault: true,
    });
  }

  const status = await getUserCredentialStatus(context.workspace.id, context.userId);
  return NextResponse.json({ workspaceId: context.workspace.id, ...status });
}
