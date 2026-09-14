import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const startup = vi.hoisted(() => ({
  migrate: vi.fn(),
  warm: vi.fn(),
  register: vi.fn(),
}));
vi.mock("node-pg-migrate", () => ({ default: startup.migrate }));
vi.mock("@/modules/rag/local-model-warmup", () => ({ warmLocalModels: startup.warm }));
vi.mock("@/modules/jobs/register-handlers", () => ({ registerAllJobHandlers: startup.register }));

const originalArgv = process.argv;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  for (const key of ["DATABASE_URL", "BOOTSTRAP_ENABLED_PROVIDERS", "BOOTSTRAP_JIRA_SITES",
    "BOOTSTRAP_OWNER_JIRA_SITE", "BOOTSTRAP_OWNER_EMAIL", "JIRA_LOGIN_METHODS",
    "ATLASSIAN_OAUTH_CLIENT_ID", "ATLASSIAN_OAUTH_CLIENT_SECRET"]) vi.stubEnv(key, "");
  vi.stubEnv("ATLASSIAN_OAUTH_REDIRECT_URI", "http://localhost:3000/api/auth/jira/callback");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  // Intercept exit at the process boundary; no database or model is contacted.
  vi.spyOn(process, "exit").mockImplementation((() => {}) as typeof process.exit);
});

afterEach(() => {
  process.argv = originalArgv;
});

it("lets the web startup finish with the old Azure environment template", async () => {
  await import("../../instrumentation-node");
  await vi.waitFor(() => expect(startup.warm).toHaveBeenCalledOnce());
  expect(process.exit).not.toHaveBeenCalled();
  expect(startup.migrate).not.toHaveBeenCalled();
});

it("lets the worker reach handler registration with the old Azure environment template", async () => {
  vi.stubEnv("DATABASE_URL", "postgres://unused.test/never-connected");
  process.argv = [originalArgv[0], fileURLToPath(new URL("../../worker/main.ts", import.meta.url))];
  // Stop after configuration validation, before worker registration opens the DB.
  const stop = new Error("stop at worker service boundary");
  startup.register.mockImplementation(() => { throw stop; });

  await import("../../worker/main");
  await vi.waitFor(() => expect(startup.register).toHaveBeenCalledOnce());
  expect(console.error).toHaveBeenCalledWith("[worker] failed to start.", stop);
});
