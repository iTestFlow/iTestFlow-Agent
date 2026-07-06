import { afterEach, vi } from "vitest";

// jest-dom matchers only matter in DOM environments (the 4 @vitest-environment jsdom
// files); with per-file isolation this import would otherwise be re-evaluated for every
// node-environment test file — a compounding, pure-waste setup cost. `document` exists
// only under jsdom, so this loads the matchers exactly where they can be used.
if (typeof document !== "undefined") {
  await import("@testing-library/jest-dom/vitest");
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
