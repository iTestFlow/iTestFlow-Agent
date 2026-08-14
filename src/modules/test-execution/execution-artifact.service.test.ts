import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { put, sqlRun } = vi.hoisted(() => ({ put: vi.fn(), sqlRun: vi.fn() }));

vi.mock("@/modules/shared/infrastructure/database/db", () => ({
  createId: () => "pwart_test",
  nowIso: () => "2026-08-14T00:00:00.000Z",
  sqlGet: vi.fn(),
  sqlRun,
}));
vi.mock("@/modules/documents/storage/local-filesystem-backend", () => ({
  LocalFilesystemStorageBackend: class {
    put = put;
  },
}));

import { artifactUrls, importHttpArtifact, resolveProtectedArtifactUrl } from "./execution-artifact.service";

describe("protected Playwright MCP artifacts", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    put.mockResolvedValue({ storageKey: "sha256/test" });
    sqlRun.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts only URLs within the configured origin and path prefix", () => {
    expect(resolveProtectedArtifactUrl("https://mcp.example/artifacts/", "trace/run-1.zip").toString()).toBe("https://mcp.example/artifacts/trace/run-1.zip");
    expect(() => resolveProtectedArtifactUrl("https://mcp.example/artifacts/", "https://evil.example/artifacts/trace.zip")).toThrow("outside");
    expect(() => resolveProtectedArtifactUrl("https://mcp.example/artifacts/", "https://mcp.example/private/trace.zip")).toThrow("outside");
    expect(() => resolveProtectedArtifactUrl(
      "https://mcp.example/artifacts/", "https://mcp.example/artifacts/public%2F..%2Fprivate/trace.zip",
    )).toThrow("outside");
    expect(() => resolveProtectedArtifactUrl(
      "https://mcp.example/artifacts/", "https://user:secret@mcp.example/artifacts/trace.zip",
    )).toThrow(/credentials/i);
  });

  it("extracts trace links without treating navigated page URLs as artifacts", () => {
    expect(artifactUrls({ content: [{ url: "https://mcp.example/artifacts/trace-1.zip" }, { url: "https://app.example/dashboard" }] })).toEqual(["https://mcp.example/artifacts/trace-1.zip"]);
  });

  it("uses a signed artifact URL for the fetch without persisting its credentials", async () => {
    const signedUrl = "https://mcp.example/artifacts/run-42/trace.zip?sig=temporary-download-secret&expires=tomorrow#download";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "content-type": "application/zip", "content-length": "3" },
    }));

    await importHttpArtifact({
      workspaceId: "workspace-1",
      runId: "run-1",
      sourceUrl: signedUrl,
      artifactBaseUrl: "https://mcp.example/artifacts/",
      kind: "trace",
    });

    expect(fetchSpy).toHaveBeenCalledWith(new URL(signedUrl), expect.objectContaining({ redirect: "error" }));
    expect(sqlRun).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      sourceUrl: "https://mcp.example/artifacts/run-42/trace.zip",
    }));
    expect(JSON.stringify(sqlRun.mock.calls)).not.toContain("temporary-download-secret");
  });
});
