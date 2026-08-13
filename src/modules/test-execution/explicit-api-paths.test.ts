import { describe, expect, it } from "vitest";

import { extractExplicitApiRequests, readOnlyExplicitApiRequests } from "./explicit-api-paths";

const API_BASE_URL = "https://automationexercise.com/api/";

function extract(source: string, apiBaseUrl: string | null = API_BASE_URL) {
  return [...extractExplicitApiRequests({ sources: [source], apiBaseUrl })];
}

describe("extractExplicitApiRequests — adjacent form", () => {
  it("extracts exact method+path requests for every supported method", () => {
    expect([...extractExplicitApiRequests({
      sources: [
        "Call GET /orders/42?full=true, then HEAD /health.",
        "POST /orders creates the record; DELETE /orders/42 removes it.",
      ],
      apiBaseUrl: API_BASE_URL,
    })]).toEqual([
      "GET /orders/42?full=true",
      "HEAD /health",
      "POST /orders",
      "DELETE /orders/42",
    ]);
  });

  it("extracts PUT and PATCH and normalizes the method casing", () => {
    expect(extract("put /a and PATCH /b")).toEqual(["PUT /a", "PATCH /b"]);
  });

  it("rejects protocol-relative targets and foreign origins", () => {
    expect(extract("GET https://evil.example/path; POST //evil.example/path; GET /safe"))
      .toEqual(["GET /safe"]);
  });

  it("trims trailing punctuation", () => {
    expect(extract("Send POST /orders/checkout.")).toEqual(["POST /orders/checkout"]);
  });
});

describe("extractExplicitApiRequests — unambiguous pairing", () => {
  it("pairs a labeled endpoint with a method named elsewhere in the step", () => {
    // The shape API documentation uses, and the shape testers paste.
    const step = [
      "Create/Register User Account",
      "service: createAccount",
      "Request Method: POST",
      "Request Parameters: name, email, password, title",
      "Response Code: 201",
    ].join("\n");

    expect(extract(step)).toEqual(["POST /createAccount"]);
  });

  it("resolves a same-origin absolute URL to its path", () => {
    const step = "API URL: https://automationexercise.com/api/createAccount\nRequest Method: POST";
    expect(extract(step)).toEqual(["POST /api/createAccount"]);
  });

  it("ignores an absolute URL on a foreign origin", () => {
    const step = "API URL: https://evil.example/api/createAccount\nRequest Method: POST";
    expect(extract(step)).toEqual([]);
  });

  it("ignores a same-origin URL when no base URL is configured", () => {
    const step = "API URL: https://automationexercise.com/api/createAccount\nRequest Method: POST";
    expect(extract(step, null)).toEqual([]);
  });

  it("pairs a slash-prefixed path with a method named on another line", () => {
    expect(extract("Endpoint /verifyLogin\nRequest Method: DELETE")).toEqual(["DELETE /verifyLogin"]);
  });
});

describe("extractExplicitApiRequests — pairing stays unambiguous", () => {
  it("refuses to pair when the step names more than one method", () => {
    const step = "service: createAccount\nRequest Method: POST\nUse DELETE to clean up afterwards.";
    // Two methods, one endpoint: which one was meant is a guess, so neither pairs.
    expect(extract(step)).toEqual([]);
  });

  it("refuses to pair when the step names more than one endpoint", () => {
    const step = "service: createAccount\nendpoint: deleteAccount\nRequest Method: POST";
    expect(extract(step)).toEqual([]);
  });

  it("keeps adjacent matches even when pairing is ambiguous", () => {
    const step = "Call POST /createAccount first.\nThen use DELETE for cleanup.";
    // Two methods blocks pairing, but the adjacent match is still explicit.
    expect(extract(step)).toEqual(["POST /createAccount"]);
  });

  it("never treats prose nouns as an endpoint", () => {
    const step = "Open the orders page and confirm the account was created.\nRequest Method: POST";
    expect(extract(step)).toEqual([]);
  });

  it("never reads a lowercase prose verb as a method", () => {
    // "get" in prose must not become a GET; documentation writes methods in caps.
    expect(extract("get the order details\nservice: orderDetails")).toEqual([]);
  });

  it("does not treat a slash inside a word as a path", () => {
    // "Create/Register" is prose, not an endpoint.
    expect(extract("Create/Register User Account\nRequest Method: POST")).toEqual([]);
  });

  it("yields nothing for a step that names no API request at all", () => {
    expect(extract("Verify that the home page is visible successfully")).toEqual([]);
  });
});

describe("readOnlyExplicitApiRequests", () => {
  it("keeps only GET/HEAD entries for legacy-intent runs", () => {
    const requests = extractExplicitApiRequests({
      sources: ["GET /orders, HEAD /health, POST /orders, DELETE /orders/1"],
      apiBaseUrl: API_BASE_URL,
    });
    expect([...readOnlyExplicitApiRequests(requests)]).toEqual(["GET /orders", "HEAD /health"]);
  });
});
