import { NextResponse } from "next/server";
import { z } from "zod";

import { nowIso } from "@/modules/shared/infrastructure/database/db";
import { requireSession, SessionError } from "@/modules/auth/session.service";
import {
  authenticatedIdentityMatchesStoredUser,
  getStoredUserIdentity,
} from "@/modules/auth/user.service";
import { resolveActiveWorkspaceForUser } from "@/modules/workspace/workspace.service";
import { PatAuthProvider } from "@/modules/auth/pat-auth-provider";
import {
  getUserCredentialStatus,
  resolveUserLlmConfig,
  saveUserLlmSettings,
  storeUserAzurePat,
  storeUserLlmApiKey,
  updateUserLlmModel,
} from "@/modules/credentials/credential.service";
import { checkRateLimit, clientIp } from "@/modules/security/rate-limit";
import { routeErrorResponse } from "@/modules/shared/errors/route-error-response";

export const runtime = "nodejs";

/**
 * "My Credentials" API. Returns only masked previews + status (never raw
 * secrets). Updates store the caller's own encrypted Azure PAT and/or LLM key,
 * validating the PAT against the workspace's Azure org first. A user can only
 * read/update their own credentials — the user is resolved from the session.
 */
async function resolveContext() {
  const session = await requireSession();
  const workspace = await resolveActiveWorkspaceForUser(session.userId, session.activeWorkspaceId);
  if (!workspace) {
    const error = new Error("No workspace membership found for this user.");
    error.name = "NoWorkspaceError";
    throw error;
  }
  return { userId: session.userId, workspace };
}

function errorResponse(error: unknown) {
  if (error instanceof SessionError) return routeErrorResponse(error, { domain: "auth", status: 401, fallback: "Sign in required." });
  if (error instanceof Error && error.name === "NoWorkspaceError") {
    return routeErrorResponse(error, { domain: "auth", status: 403, fallback: "No workspace membership found for this user." });
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
    { workspaceId: context.workspace.id, azureOrgUrl: context.workspace.azureOrgUrl, ...status },
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
        maxInputTokens: z.number().int().min(4000).max(2_000_000).optional(),
      })
      .optional(),
  })
  .refine((value) => value.azurePat || value.llm, {
    message: "Provide an Azure DevOps PAT and/or LLM credentials to update.",
  });

const ModelUpdateSchema = z.object({
  llm: z.object({
    provider: z.enum(["openai", "gemini", "anthropic"]),
    model: z.string().trim().min(1, "Select an LLM model."),
  }),
});

export async function PUT(request: Request) {
  const rate = await checkRateLimit(`cred-update:${clientIp(request)}`, 20, 5 * 60 * 1000);
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
    let identity;
    try {
      identity = await new PatAuthProvider().authenticate({
        organizationUrl: context.workspace.azureOrgUrl,
        personalAccessToken: parsed.data.azurePat,
      });
    } catch (error) {
      return routeErrorResponse(error, {
        domain: "azure",
        status: 422,
        fallback: "Azure DevOps PAT validation failed.",
      });
    }
    const storedIdentity = await getStoredUserIdentity(context.userId);
    if (!storedIdentity || !authenticatedIdentityMatchesStoredUser(identity, storedIdentity)) {
      return NextResponse.json(
        { error: "This PAT belongs to a different Azure DevOps account. Use a PAT from your signed-in account." },
        { status: 403 },
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
      maxInputTokens: parsed.data.llm.maxInputTokens,
      isDefault: true,
    });
  }

  const status = await getUserCredentialStatus(context.workspace.id, context.userId);
  return NextResponse.json({ workspaceId: context.workspace.id, ...status });
}

export async function PATCH(request: Request) {
  const rate = await checkRateLimit(`cred-model-update:${clientIp(request)}`, 60, 5 * 60 * 1000);
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

  const parsed = ModelUpdateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid model payload." }, { status: 400 });
  }

  const current = await resolveUserLlmConfig(context.workspace.id, context.userId);
  if (!current || current.provider !== parsed.data.llm.provider) {
    return NextResponse.json(
      { error: "Save an API key for this LLM provider before changing the model." },
      { status: 400 },
    );
  }

  await updateUserLlmModel({
    workspaceId: context.workspace.id,
    userId: context.userId,
    provider: parsed.data.llm.provider,
    model: parsed.data.llm.model,
  });

  const status = await getUserCredentialStatus(context.workspace.id, context.userId);
  return NextResponse.json({ workspaceId: context.workspace.id, ...status });
}
