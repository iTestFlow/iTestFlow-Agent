// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

describe("Web Storage test isolation", () => {
  it("provides local and session storage", () => {
    expect(window.localStorage).toBeDefined();
    expect(window.sessionStorage).toBeDefined();

    window.localStorage.setItem("test-sentinel", "local");
    window.sessionStorage.setItem("test-sentinel", "session");

    expect(window.localStorage.getItem("test-sentinel")).toBe("local");
    expect(window.sessionStorage.getItem("test-sentinel")).toBe("session");
  });

  it("starts the next test with empty storage", () => {
    expect(window.localStorage.getItem("test-sentinel")).toBeNull();
    expect(window.sessionStorage.getItem("test-sentinel")).toBeNull();
  });
});
