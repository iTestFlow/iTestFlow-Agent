import { NextResponse } from "next/server";
import { z } from "zod";

import { requireSession, SessionError } from "@/modules/auth/session.service";
import { resolveActiveWorkspaceForUser } from "@/modules/workspace/workspace.service";
import { resolveUserLlmConfig } from "@/modules/credentials/credential.service";
import { listLLMModels, LLMProviderNameSchema } from "@/modules/llm/model-catalog.service";
import { routeErrorResponse } from "@/modules/shared/errors/route-error-response";

export const runtime = "nodejs";

const RequestSchema = z.object({
  provider: LLMProviderNameSchema,
  apiKey: z.string().trim().optional(),
  baseUrl: z.string().trim().optional(),
});

/**
 * POST /api/settings/llm-models
 * Fetches available models for the given provider. The API key may be supplied
 * directly (e.g. the user just typed it in the form) or omitted — in which case
 * the user's already-saved encrypted key is used. Returns 400 if neither exists.
 */
export async function POST(request: Request) {
  let session: Awaited<ReturnType<typeof requireSession>>;
  try {
    session = await requireSession();
  } catch (error) {
    if (error instanceof SessionError) return routeErrorResponse(error, { domain: "auth", status: 401, fallback: "Sign in required." });
    throw error;
  }

  const parsed = RequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const { provider, apiKey: incomingKey, baseUrl: incomingBaseUrl } = parsed.data;

  // Resolve provider config: prefer form values; fall back to the saved key/base URL together.
  let apiKey = incomingKey?.trim() || undefined;
  let baseUrl = incomingBaseUrl?.trim() || undefined;
  if (!apiKey) {
    const workspace = await resolveActiveWorkspaceForUser(session.userId, session.activeWorkspaceId);
    if (workspace) {
      const saved = await resolveUserLlmConfig(workspace.id, session.userId);
      if (saved?.provider === provider) {
        apiKey = saved.apiKey;
        baseUrl = saved.baseUrl;
      }
    }
  }

  if (!apiKey) {
    return NextResponse.json(
      { error: "Enter an API key to load models from the provider, or save your credentials first." },
      { status: 400 },
    );
  }

  try {
    const models = await listLLMModels({ provider, apiKey, baseUrl });
    return NextResponse.json({ models });
  } catch (error) {
    return routeErrorResponse(error, {
      domain: "llm",
      provider,
      fallback: "Failed to fetch models from provider.",
    });
  }
}
