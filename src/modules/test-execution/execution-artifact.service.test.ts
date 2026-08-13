import { describe, expect, it } from "vitest";
import { artifactUrls, resolveProtectedArtifactUrl } from "./execution-artifact.service";

describe("protected Playwright MCP artifacts", () => {
  it("accepts only URLs within the configured origin and path prefix", () => {
    expect(resolveProtectedArtifactUrl("https://mcp.example/artifacts/", "trace/run-1.zip").toString()).toBe("https://mcp.example/artifacts/trace/run-1.zip");
    expect(() => resolveProtectedArtifactUrl("https://mcp.example/artifacts/", "https://evil.example/artifacts/trace.zip")).toThrow("outside");
    expect(() => resolveProtectedArtifactUrl("https://mcp.example/artifacts/", "https://mcp.example/private/trace.zip")).toThrow("outside");
  });

  it("extracts trace links without treating navigated page URLs as artifacts", () => {
    expect(artifactUrls({ content: [{ url: "https://mcp.example/artifacts/trace-1.zip" }, { url: "https://app.example/dashboard" }] })).toEqual(["https://mcp.example/artifacts/trace-1.zip"]);
  });
});
