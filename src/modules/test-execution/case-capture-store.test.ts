import { describe, expect, it } from "vitest";

import {
  CaseCaptureStore,
  MAX_CASE_CAPTURE_COUNT,
  MAX_CAPTURE_VALUE_BYTES,
  resolveJsonPointer,
} from "./case-capture-store";

describe("CaseCaptureStore", () => {
  it("extracts RFC 6901 API values and DB columns", () => {
    const store = new CaseCaptureStore();
    store.captureJson({ name: "orderId", pointer: "/data/id", document: { data: { id: 42 } } });
    store.captureRow({ name: "status", rows: [{ status: "ready" }], column: "status" });
    expect(store.resolve({ id: "{{capture:orderId}}", message: "is {{capture:status}}" }, new Map()))
      .toEqual({ id: 42, message: "is ready" });
  });

  it("keeps sensitive captures opaque in summaries and persisted evidence", () => {
    const store = new CaseCaptureStore();
    store.captureJson({ name: "accessToken", pointer: "/token", document: { token: "abc" } });
    expect(store.summaries()[0]).not.toContain("abc");
    expect(store.persistable()[0]).toMatchObject({ value: "<redacted>", sensitive: true });
    expect(() => store.resolve("{{capture:accessToken}}", new Map())).toThrow(
      "cannot be substituted into an external action",
    );
  });

  it("makes sensitivity monotonic across explicit flags, source fields, and overwrites", () => {
    const store = new CaseCaptureStore();
    store.captureJson({
      name: "apiValue",
      pointer: "/auth/access_token",
      document: { auth: { access_token: "api-token-value" } },
      sensitive: false,
    });
    store.captureRow({
      name: "dbValue",
      rows: [{ password_hash: "db-secret-value" }],
      column: "password_hash",
      sensitive: false,
    });
    store.set({ name: "sticky", value: "first-secret", sensitive: true, sourceLayer: "api" });
    store.set({ name: "sticky", value: "replacement", sensitive: false, sourceLayer: "db" }, true);

    expect(store.persistable()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "apiValue", sensitive: true, value: "<redacted>" }),
      expect.objectContaining({ name: "dbValue", sensitive: true, value: "<redacted>" }),
      expect.objectContaining({ name: "sticky", sensitive: true, value: "<redacted>" }),
    ]));
  });

  it("resolves agent secrets after capture substitution", () => {
    const store = new CaseCaptureStore();
    store.set({ name: "email", value: "qa@example.test", sensitive: false, sourceLayer: "api" });
    expect(store.resolve("{{capture:email}}/{{secret:PASSWORD}}", new Map([["PASSWORD", "pw"]])))
      .toBe("qa@example.test/pw");
  });

  it("rejects duplicates, unknown paths, and object interpolation", () => {
    const store = new CaseCaptureStore();
    store.set({ name: "value", value: 1, sensitive: false, sourceLayer: "api" });
    expect(() => store.set({ name: "value", value: 2, sensitive: false, sourceLayer: "db" })).toThrow("already exists");
    expect(() => store.captureJson({ name: "object", pointer: "", document: { id: 1 } })).toThrow(
      "must be scalar",
    );
    expect(() => resolveJsonPointer({ a: 1 }, "/missing")).toThrow("does not exist");
  });

  it("bounds capture count, individual values, and aggregate values", () => {
    const tooLarge = new CaseCaptureStore();
    expect(() => tooLarge.set({
      name: "large",
      value: "x".repeat(MAX_CAPTURE_VALUE_BYTES + 1),
      sensitive: false,
      sourceLayer: "api",
    })).toThrow("value limit");

    const countBounded = new CaseCaptureStore();
    for (let index = 0; index < MAX_CASE_CAPTURE_COUNT; index += 1) {
      countBounded.set({ name: `v${index}`, value: index, sensitive: false, sourceLayer: "api" });
    }
    expect(() => countBounded.set({
      name: "overflow",
      value: 1,
      sensitive: false,
      sourceLayer: "api",
    })).toThrow("at most");

    const aggregateBounded = new CaseCaptureStore();
    for (let index = 0; index < 4; index += 1) {
      aggregateBounded.set({
        name: `chunk${index}`,
        value: "x".repeat(MAX_CAPTURE_VALUE_BYTES),
        sensitive: false,
        sourceLayer: "db",
      });
    }
    expect(() => aggregateBounded.set({
      name: "aggregateOverflow",
      value: "x",
      sensitive: false,
      sourceLayer: "db",
    })).toThrow("aggregate limit");
  });

  it("supports escaped JSON pointer segments", () => {
    expect(resolveJsonPointer({ "a/b": { "~key": true } }, "/a~1b/~0key")).toBe(true);
  });
});
