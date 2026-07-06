import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/modules/auth/session.service", () => ({
  requireSession: vi.fn(async () => ({ userId: "user_1", activeWorkspaceId: null })),
  SessionError: class SessionError extends Error {},
}));

vi.mock("@/modules/workspace/workspace.service", () => ({
  resolveActiveWorkspaceForUser: vi.fn(async () => ({ id: "ws_1" })),
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
import { requireSession, SessionError } from "@/modules/auth/session.service";
import { resolveUserLlmConfig } from "@/modules/credentials/credential.service";
import { listLLMModels } from "@/modules/llm/model-catalog.service";

describe("POST /api/settings/llm-models", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireSession).mockResolvedValue({
      sessionId: "session_1",
      userId: "user_1",
      activeWorkspaceId: null,
    });
    vi.mocked(resolveUserLlmConfig).mockResolvedValue({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      apiKey: "sk-saved",
      baseUrl: "https://anthropic-proxy.example.com",
    });
  });

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

  it("returns 400 without calling the provider when neither form nor saved credentials supply a key", async () => {
    vi.mocked(resolveUserLlmConfig).mockResolvedValue(null);

    const response = await POST(
      new Request("http://localhost/api/settings/llm-models", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "openai" }),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Enter an API key to load models from the provider, or save your credentials first.",
    });
    expect(listLLMModels).not.toHaveBeenCalled();
  });

  it("returns 401 before reading the request when the session is missing", async () => {
    vi.mocked(requireSession).mockRejectedValue(new SessionError("Sign in required."));

    const response = await POST(
      new Request("http://localhost/api/settings/llm-models", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Sign in required." });
    expect(resolveUserLlmConfig).not.toHaveBeenCalled();
    expect(listLLMModels).not.toHaveBeenCalled();
  });
});
