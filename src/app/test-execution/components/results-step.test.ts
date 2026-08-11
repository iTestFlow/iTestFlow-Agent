import { describe, expect, it } from "vitest";

import { humanizeActionType, summarizeActionEvidence } from "./results-step";

describe("multi-layer result evidence", () => {
  it("labels generic action types for the timeline", () => {
    expect(humanizeActionType("api.execute_operation")).toBe("Api Execute Operation");
    expect(humanizeActionType("db-select")).toBe("Db Select");
  });

  it("renders only allowlisted metadata and never arbitrary bodies or credentials", () => {
    // Persisted observations nest the layer payload under `data`.
    expect(
      summarizeActionEvidence(
        { method: "get", path: "/orders/42", authorization: "Bearer secret" },
        { data: { status: 200, rowCount: 1, body: { password: "secret" } } },
      ),
    ).toBe("GET /orders/42 · status 200 · 1 row(s)");
  });
});
