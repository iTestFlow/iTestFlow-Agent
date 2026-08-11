import { describe, expect, it } from "vitest";

import { extractExplicitApiReadPaths } from "./explicit-api-paths";

describe("extractExplicitApiReadPaths", () => {
  it("extracts only exact GET/HEAD relative paths", () => {
    expect([...extractExplicitApiReadPaths(
      "Call GET /orders/42?full=true, then HEAD /health.",
      "POST /orders is not dynamically authorized",
    )]).toEqual(["/orders/42?full=true", "/health"]);
  });

  it("rejects absolute and protocol-relative targets", () => {
    expect([...extractExplicitApiReadPaths(
      "GET https://evil.example/path; GET //evil.example/path; GET /safe",
    )]).toEqual(["/safe"]);
  });
});
