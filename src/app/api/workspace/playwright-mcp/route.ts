import { NextResponse } from "next/server";
import { z } from "zod";

import {
  getPlaywrightMcpConfigSummary,
  resolvePlaywrightMcpConfig,
  savePlaywrightMcpConfig,
} from "@/modules/test-execution/playwright-mcp-config.service";
import { connectPlaywrightMcp } from "@/modules/test-execution/playwright-mcp-client";
import { resolveWorkspaceRequest, workspaceRequestError } from "@/modules/workspace/workspace-request";

export const runtime = "nodejs";

function isAllowedHttpUrl(value: string): boolean {
  const url = new URL(value);
  if (url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname)) return true;
  if (url.protocol !== "https:") return false;
  const allowed = new Set((process.env.PLAYWRIGHT_MCP_HTTP_ALLOWED_ORIGINS ?? "").split(",").map((entry) => entry.trim()).filter(Boolean));
  return allowed.has(url.origin);
}

const HttpConfigSchema = z.object({
  transport: z.literal("http"),
  endpoint: z.string().url().refine(isAllowedHttpUrl, "Use HTTPS, or HTTP only for localhost."),
  artifactBaseUrl: z.string().url().refine(isAllowedHttpUrl, "Use HTTPS, or HTTP only for localhost.").nullable().optional(),
  bearerToken: z.string().trim().min(1).nullable().optional(),
  enabled: z.boolean().optional(),
}).strict();

const StdioConfigSchema = z.object({
  transport: z.literal("stdio"),
  enabled: z.boolean().optional(),
}).strict();

const ConfigSchema = z.discriminatedUnion("transport", [HttpConfigSchema, StdioConfigSchema]);

async function ownerContext() {
  return resolveWorkspaceRequest(["owner", "admin"]);
}

export async function GET() {
  try {
    const context = await ownerContext();
    return NextResponse.json(
      { workspaceId: context.workspace.id, config: await getPlaywrightMcpConfigSummary(context.workspace.id) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const response = workspaceRequestError(error);
    if (response) return response;
    throw error;
  }
}

export async function PUT(request: Request) {
  let context: Awaited<ReturnType<typeof ownerContext>>;
  try {
    context = await ownerContext();
  } catch (error) {
    const response = workspaceRequestError(error);
    if (response) return response;
    throw error;
  }
  const parsed = ConfigSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid Playwright MCP configuration." }, { status: 400 });
  }
  const existing = await resolvePlaywrightMcpConfig(context.workspace.id);
  const candidate = {
    status: parsed.data.enabled === false ? "disabled" as const : "configured" as const,
    transport: parsed.data.transport,
    endpoint: parsed.data.transport === "http" ? parsed.data.endpoint : null,
    artifactBaseUrl: parsed.data.transport === "http" ? parsed.data.artifactBaseUrl ?? null : null,
    bearerToken: parsed.data.transport === "http"
      ? parsed.data.bearerToken === undefined ? existing?.bearerToken ?? null : parsed.data.bearerToken
      : null,
  };
  if (candidate.status === "configured") {
    try {
      const connection = await connectPlaywrightMcp(candidate);
      await connection.close();
    } catch {
      return NextResponse.json({ error: "Playwright MCP connection validation failed. Check the endpoint, credentials, allowed origin, and required tools." }, { status: 422 });
    }
  }
  const config = await savePlaywrightMcpConfig({
    workspaceId: context.workspace.id,
    userId: context.userId,
    ...parsed.data,
  });
  return NextResponse.json({ workspaceId: context.workspace.id, config });
}
