import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(path.join(process.cwd(), "migrations/1710000037000_playwright_mcp_execution.js"), "utf8");

describe("Playwright execution migration contract", () => {
  it("creates fenced, lease-refreshed publication receipts", () => {
    expect(migration).toContain("result_json jsonb NOT NULL DEFAULT '[]'");
    expect(migration).toContain("updated_at text NOT NULL");
    expect(migration).toContain("lease_token text NOT NULL");
  });

  it("atomically terminalizes runs, cases, and steps when their job cannot resume", () => {
    expect(migration).toContain("playwright_execution_job_terminalize");
    expect(migration).toContain("UPDATE playwright_execution_steps");
    expect(migration).toContain("UPDATE playwright_execution_cases");
    expect(migration).toContain("UPDATE playwright_execution_runs");
  });
});
