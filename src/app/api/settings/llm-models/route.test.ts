import { describe, expect, it, vi } from "vitest";

vi.mock("@/modules/auth/session.service", () => ({
  requireSession: vi.fn(async () => ({ userId: "user_1" })),
  SessionError: class SessionError extends Error {},
}));

vi.mock("@/modules/workspace/workspace.service", () => ({
  getPrimaryWorkspaceForUser: vi.fn(async () => ({ id: "ws_1" })),
}));

vi.mock("@/modules/credentials/credential.service", () => ({
  resolveUserLlmConfig: vi.fn(async () => ({
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    apiKey: "sk-saved",
    baseUrl: "https://anthropic-proxy.example.com",
  })),
}));

vi.mock("@/modules/llm/model-catalog.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/llm/model-catalog.service")>();
  return {
    ...actual,
    listLLMModels: vi.fn(async () => [
      { id: "claude-sonnet-4-5", displayName: "Claude Sonnet 4.5", source: "anthropic" },
    ]),
  };
});

import { POST } from "./route";
import { listLLMModels } from "@/modules/llm/model-catalog.service";

describe("POST /api/settings/llm-models", () => {
  it("uses the saved base URL with the saved API key when only the provider is posted", async () => {
    const response = await POST(
      new Request("http://localhost/api/settings/llm-models", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "anthropic" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(listLLMModels).toHaveBeenCalledWith({
      provider: "anthropic",
      apiKey: "sk-saved",
      baseUrl: "https://anthropic-proxy.example.com",
    });
  });
});
