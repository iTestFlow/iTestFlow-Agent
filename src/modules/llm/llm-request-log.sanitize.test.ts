import { describe, expect, it } from "vitest";

import { sanitizeLLMLogPayload } from "@/modules/llm/llm-request-log.service";

describe("sanitizeLLMLogPayload (secret redaction)", () => {
  it("redacts sensitive keys at the top level", () => {
    const out = sanitizeLLMLogPayload({
      apiKey: "sk-secret",
      Authorization: "Bearer abc",
      pat: "azure-pat",
      password: "pw",
      token: "t",
      secret: "s",
      model: "gpt-4o",
    }) as Record<string, unknown>;

    expect(out.apiKey).toBe("[REDACTED]");
    expect(out.Authorization).toBe("[REDACTED]");
    expect(out.pat).toBe("[REDACTED]");
    expect(out.password).toBe("[REDACTED]");
    expect(out.token).toBe("[REDACTED]");
    expect(out.secret).toBe("[REDACTED]");
    expect(out.model).toBe("gpt-4o"); // non-sensitive preserved
  });

  it("recurses into nested objects and arrays", () => {
    const out = sanitizeLLMLogPayload({
      headers: { authorization: "Bearer abc", "x-api-key": "k" },
      items: [{ personalAccessToken: "p", ok: 1 }],
    }) as { headers: Record<string, unknown>; items: Array<Record<string, unknown>> };

    expect(out.headers.authorization).toBe("[REDACTED]");
    expect(out.headers["x-api-key"]).toBe("[REDACTED]");
    expect(out.items[0].personalAccessToken).toBe("[REDACTED]");
    expect(out.items[0].ok).toBe(1);
  });

  it("passes primitives through unchanged", () => {
    expect(sanitizeLLMLogPayload("hello")).toBe("hello");
    expect(sanitizeLLMLogPayload(42)).toBe(42);
    expect(sanitizeLLMLogPayload(null)).toBe(null);
  });
});
