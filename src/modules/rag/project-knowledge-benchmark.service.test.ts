import { describe, expect, it, vi } from "vitest";

vi.mock("@/modules/shared/infrastructure/database/db", () => ({
  createId: vi.fn(),
  enqueueBackgroundWrite: vi.fn(),
  nowIso: vi.fn(),
  sqlAll: vi.fn(),
  sqlRun: vi.fn(),
}));

import { sanitizeProjectKnowledgeBenchmarkQuestion } from "./project-knowledge-benchmark.service";

describe("project knowledge benchmark sanitization", () => {
  it("removes identifiers and secrets while preserving the business question", () => {
    expect(sanitizeProjectKnowledgeBenchmarkQuestion(
      "Can user jane@example.com open https://dev.azure.com/org/p/12345 with sk-secret_abcdefghijkl?",
    )).toBe("Can user [email] open [url] with [secret]?");
  });

  it("normalizes whitespace and caps stored benchmark text", () => {
    expect(sanitizeProjectKnowledgeBenchmarkQuestion("  How   does checkout   recover?  "))
      .toBe("How does checkout recover?");
    expect(sanitizeProjectKnowledgeBenchmarkQuestion("x".repeat(900))).toHaveLength(600);
  });
});
