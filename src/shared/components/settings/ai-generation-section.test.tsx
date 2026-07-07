// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AiGenerationSection } from "./ai-generation-section";

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
  },
}));

const credentialStatus = {
  workspaceId: "ws_1",
  azureOrgUrl: "https://dev.azure.com/org-a",
  azurePat: { status: "configured", maskedPreview: "****pat", isStale: false },
  llm: {
    status: "configured",
    maskedPreview: "sk-****key",
    provider: "openai",
    model: "gpt-4.1",
    isStale: false,
  },
};

const workspaceSettings = {
  settings: { retrievalTopK: null, maxOutputTokenCap: null, llmRetryAttempts: null },
  defaults: {
    maxOutputTokenCapDefault: 32000,
    maxOutputTokenCapOptions: [16000, 32000, 64000],
    retryAttemptsDefault: 1,
    retryAttemptsOptions: [0, 1, 2, 3],
  },
};

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

describe("AiGenerationSection", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockImplementation((input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/api/settings/credentials")) return jsonResponse(credentialStatus);
      if (url.includes("/api/workspace/settings")) return jsonResponse(workspaceSettings);
      return jsonResponse({ error: `Unexpected request: ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(cleanup);

  it("clears the selected model when the provider changes away from the saved provider", async () => {
    render(<AiGenerationSection />);

    await screen.findByText("gpt-4.1");

    fireEvent.change(screen.getByLabelText("LLM Provider"), { target: { value: "gemini" } });

    await waitFor(() => {
      expect(screen.queryByText("gpt-4.1")).not.toBeInTheDocument();
    });
    expect(screen.getByRole("combobox", { name: "Save an API key first" })).toBeDisabled();
  });

  it("restores the saved model when the saved provider is selected again", async () => {
    render(<AiGenerationSection />);

    await screen.findByText("gpt-4.1");

    const providerSelect = screen.getByLabelText("LLM Provider");
    fireEvent.change(providerSelect, { target: { value: "gemini" } });
    fireEvent.change(providerSelect, { target: { value: "openai" } });

    expect(screen.getByText("gpt-4.1")).toBeInTheDocument();
  });
});
