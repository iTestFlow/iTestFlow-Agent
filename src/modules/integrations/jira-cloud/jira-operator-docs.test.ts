import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Jira Cloud operator documentation", () => {
  it("documents the complete provider and backend lifecycle without example secrets", () => {
    const docPath = join(process.cwd(), "docs/jira-cloud.md");
    expect(existsSync(docPath)).toBe(true);
    const docs = readFileSync(docPath, "utf8");
    const deployment = readFileSync(join(process.cwd(), "docs/deployment.md"), "utf8");
    const readme = readFileSync(join(process.cwd(), "README.md"), "utf8");
    const env = readFileSync(join(process.cwd(), ".env.example"), "utf8");
    for (const heading of ["# Jira Cloud Operations", "## Atlassian OAuth Setup", "## Connect-to-Disconnect Flow", "## Artifact Backends", "## Webhooks and Synchronization", "## Recovery and Diagnostics", "## Rollback"]) {
      expect(docs).toContain(heading);
    }
    for (const scope of ["offline_access", "read:me", "read:jira-work", "write:jira-work", "read:jira-user", "manage:jira-webhook"]) expect(docs).toContain(scope);
    for (const variable of ["ATLASSIAN_OAUTH_CLIENT_ID", "ATLASSIAN_OAUTH_CLIENT_SECRET", "ATLASSIAN_OAUTH_REDIRECT_URI", "ATLASSIAN_ALLOWED_CLOUD_IDS", "ITESTFLOW_PUBLIC_URL", "APP_ENCRYPTION_KEY", "BOOTSTRAP_OWNER_JIRA_SITE", "BOOTSTRAP_JIRA_SITES", "BOOTSTRAP_ENABLED_PROVIDERS"]) {
      expect(docs).toContain(variable);
      expect(env).toContain(`${variable}=`);
    }
    expect(docs).toContain("Plain Jira");
    expect(docs).toContain("Xray Cloud");
    expect(docs).toContain("Zephyr Scale Cloud");
    expect(docs).toContain("User Identity API");
    expect(docs).toMatch(/enable[^.]*User Identity API[^.]*before deploying/i);
    expect(docs).toContain("account_id");
    expect(docs).toContain("accountId");
    expect(docs).toContain("provider_subject");
    expect(docs).toMatch(/no duplicate (?:user|identity)/i);
    expect(docs).toMatch(/fresh Jira Cloud deployment[^.]*BOOTSTRAP_JIRA_SITES[^.]*owner/i);
    expect(docs).toMatch(/optional only[^.]*upgrade[^.]*active connected Jira OAuth[^.]*principal/i);
    expect(docs).toMatch(/update `BOOTSTRAP_JIRA_SITES`[^.]*before restarting/i);
    expect(docs).toMatch(/next successful OAuth[^.]*reconcil/i);
    const renameSection = docs.slice(
      docs.indexOf("### Renaming a Jira Site URL"),
      docs.indexOf("## Connect-to-Disconnect Flow"),
    );
    expect(renameSection.indexOf("Update `BOOTSTRAP_JIRA_SITES`")).toBeLessThan(renameSection.indexOf("Restart the application"));
    expect(renameSection.indexOf("Restart the application")).toBeLessThan(renameSection.indexOf("next successful OAuth"));
    expect(docs).toMatch(/legacy site-less[^.]*compatibility/i);
    expect(docs).toMatch(/legacy site-less[^.]*remains callable[^.]*allowlisted[^.]*first user[^.]*owner/i);
    expect(docs).not.toContain("compatibility with old links only");
    expect(docs).not.toContain("without them a Jira site is created lazily on its first OAuth login");
    expect(deployment).toMatch(/fresh Jira Cloud deployment[^.]*BOOTSTRAP_JIRA_SITES[^.]*owner/i);
    expect(deployment).toMatch(/omitted only[^.]*upgrade[^.]*connected Jira OAuth[^.]*principal/i);
    expect(deployment).toContain("User Identity API");
    expect(deployment).toMatch(/site-qualified starts[^.]*reject unconfigured sites[^.]*legacy site-less[^.]*remains callable/i);
    const bootstrapChecklist = deployment
      .split(/\r?\n/)
      .find((line) => line.startsWith("- [ ]") && line.includes("BOOTSTRAP_JIRA_SITES"));
    expect(bootstrapChecklist).toMatch(/unless[^.]*upgrade[^.]*active connected Jira OAuth[^.]*principal/i);
    expect(bootstrapChecklist).toMatch(/for Jira Cloud deployments[^.]*ATLASSIAN_\*/i);
    expect(readme).toMatch(/fresh Jira Cloud deployment[^.]*BOOTSTRAP_JIRA_SITES[^.]*owner/i);
    expect(env).toMatch(/Fresh Jira Cloud deployments[^\n]*BOOTSTRAP_JIRA_SITES/i);
    expect(env).toMatch(/optional only[^\n]*upgrade[^\n]*connected Jira OAuth[^\n]*principal/i);
    expect(env).toContain("read:me");
    expect(docs).not.toMatch(/(client_secret|api_token|access_token)\s*=\s*[^<\s]/i);
  });
});
