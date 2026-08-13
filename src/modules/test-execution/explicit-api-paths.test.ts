import { describe, expect, it } from "vitest";

import { extractExplicitApiRequests, readOnlyExplicitApiRequests } from "./explicit-api-paths";

describe("extractExplicitApiRequests", () => {
  it("extracts exact method+path requests for every supported method", () => {
    expect([...extractExplicitApiRequests(
      "Call GET /orders/42?full=true, then HEAD /health.",
      "POST /orders creates the record; DELETE /orders/42 removes it.",
    )]).toEqual([
      "GET /orders/42?full=true",
      "HEAD /health",
      "POST /orders",
      "DELETE /orders/42",
    ]);
  });

  it("extracts PUT and PATCH and normalizes the method casing", () => {
    expect([...extractExplicitApiRequests("put /a and PATCH /b")]).toEqual([
      "PUT /a",
      "PATCH /b",
    ]);
  });

  it("rejects absolute and protocol-relative targets", () => {
    expect([...extractExplicitApiRequests(
      "GET https://evil.example/path; POST //evil.example/path; GET /safe",
    )]).toEqual(["GET /safe"]);
  });

  it("trims trailing punctuation", () => {
    expect([...extractExplicitApiRequests("Send POST /orders/checkout.")]).toEqual([
      "POST /orders/checkout",
    ]);
  });
});

describe("readOnlyExplicitApiRequests", () => {
  it("keeps only GET/HEAD entries for legacy-intent runs", () => {
    const requests = extractExplicitApiRequests(
      "GET /orders, HEAD /health, POST /orders, DELETE /orders/1",
    );
    expect([...readOnlyExplicitApiRequests(requests)]).toEqual([
      "GET /orders",
      "HEAD /health",
    ]);
  });
});
