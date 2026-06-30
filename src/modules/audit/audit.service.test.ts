import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  createId: vi.fn(() => "audit-1"),
  nowIso: vi.fn(() => "2026-06-29T00:00:00.000Z"),
  sqlRun: vi.fn(async () => 1),
  enqueueBackgroundWrite: vi.fn((_label: string, operation: () => unknown) => operation()),
}));

vi.mock("@/modules/shared/infrastructure/database/db", () => db);

import { writeAuditLog } from "./audit.service";
import { writeGenerationFailureAudit } from "./generation-failure-audit";
import { projectScope } from "@/test/factories";

describe("audit logging", () => {
  beforeEach(() => vi.clearAllMocks());

  it("queues a parameterized audit insert and serializes details", () => {
    writeAuditLog({
      workspaceId: "ws",
      action: "test.action",
      status: "Success",
      actor: "qa",
      message: "Done",
      details: { count: 2 },
    });
    expect(db.enqueueBackgroundWrite).toHaveBeenCalledWith("audit:test.action", expect.any(Function));
    expect(db.sqlRun).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO audit_logs"),
      expect.objectContaining({
        id: "audit-1",
        workspaceId: "ws",
        detailsJson: "{\"count\":2}",
      }),
    );
  });

  it("marks token-limit failures and skips invalid scopes", () => {
    writeGenerationFailureAudit({
      scope: projectScope(),
      actor: "qa",
      action: "test.generate",
      label: "Generation failed.",
      error: new Error("Reached output-token limit"),
    });
    expect(db.sqlRun).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        status: "Failed",
        detailsJson: expect.stringContaining("\"truncated\":true"),
      }),
    );

    vi.clearAllMocks();
    writeGenerationFailureAudit({
      scope: {} as never,
      actor: "qa",
      action: "test.generate",
      label: "Generation failed.",
      error: "bad",
    });
    expect(db.enqueueBackgroundWrite).not.toHaveBeenCalled();
  });
});
