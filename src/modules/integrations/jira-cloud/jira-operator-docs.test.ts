import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Jira Cloud operator documentation", () => {
  it("documents the complete provider and backend lifecycle without example secrets", () => {
    const docPath = join(process.cwd(), "docs/jira-cloud.md");
    expect(existsSync(docPath)).toBe(true);
    const docs = readFileSync(docPath, "utf8");
    const env = readFileSync(join(process.cwd(), ".env.example"), "utf8");
    for (const heading of ["# Jira Cloud Operations", "## Atlassian OAuth Setup", "## Connect-to-Disconnect Flow", "## Artifact Backends", "## Webhooks and Synchronization", "## Recovery and Diagnostics", "## Rollback"]) {
      expect(docs).toContain(heading);
    }
    for (const scope of ["offline_access", "read:jira-work", "write:jira-work", "read:jira-user", "manage:jira-webhook"]) expect(docs).toContain(scope);
    for (const variable of ["ATLASSIAN_OAUTH_CLIENT_ID", "ATLASSIAN_OAUTH_CLIENT_SECRET", "ATLASSIAN_OAUTH_REDIRECT_URI", "ATLASSIAN_ALLOWED_CLOUD_IDS", "ITESTFLOW_PUBLIC_URL", "APP_ENCRYPTION_KEY"]) {
      expect(docs).toContain(variable);
      expect(env).toContain(`${variable}=`);
    }
    expect(docs).toContain("Plain Jira");
    expect(docs).toContain("Xray Cloud");
    expect(docs).toContain("Zephyr Scale Cloud");
    expect(docs).not.toMatch(/(client_secret|api_token|access_token)\s*=\s*[^<\s]/i);
  });
});
