import { afterEach, vi } from "vitest";

// jest-dom matchers only matter in DOM environments (the @vitest-environment jsdom
// files); with per-file isolation this import would otherwise be re-evaluated for every
// node-environment test file — a compounding, pure-waste setup cost. `document` exists
// only under jsdom, so this loads the matchers exactly where they can be used.
if (typeof document !== "undefined") {
  await import("@testing-library/jest-dom/vitest");
}

// EMBEDDINGS_PROVIDER defaults to "local" (zero-setup) outside tests, but leaving that
// default active here would make suites that call the real indexing/search functions
// with no explicit embeddingProvider override (most .db.test.ts files) reach for the
// real in-process ONNX model — slow, network-dependent, and non-deterministic. Tests
// that specifically want a provider stub it themselves; everything else should stay off.
process.env.EMBEDDINGS_PROVIDER = "off";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
