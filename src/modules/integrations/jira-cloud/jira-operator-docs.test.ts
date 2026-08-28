import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Jira Cloud operator documentation", () => {
  it("documents the complete API-token provider and backend lifecycle without example secrets", () => {
    const docPath = join(process.cwd(), "docs/jira-cloud.md");
    expect(existsSync(docPath)).toBe(true);
    const docs = readFileSync(docPath, "utf8");
    const deployment = readFileSync(join(process.cwd(), "docs/deployment.md"), "utf8");
    const readme = readFileSync(join(process.cwd(), "README.md"), "utf8");
    const env = readFileSync(join(process.cwd(), ".env.example"), "utf8");

    for (const heading of ["# Jira Cloud Operations", "## Atlassian API Token Setup", "## Connect-to-Disconnect Flow", "## Artifact Backends", "## Polling and Synchronization", "## Recovery and Diagnostics", "## Rollback"]) {
      expect(docs).toContain(heading);
    }

    // API-token guidance: where to create one, both token kinds, and the exact
    // scope list a scoped token requires.
    expect(docs).toContain("id.atlassian.com/manage-profile/security/api-tokens");
    expect(docs).toMatch(/scoped/i);
    expect(docs).toMatch(/classic/i);
    for (const scope of ["read:jira-work", "write:jira-work", "read:jira-user"]) expect(docs).toContain(scope);
    expect(docs).toMatch(/one-year lifetime|caps every API token at a one-year/i);

    for (const variable of ["APP_ENCRYPTION_KEY", "BOOTSTRAP_OWNER_JIRA_SITE", "BOOTSTRAP_JIRA_SITES", "BOOTSTRAP_ENABLED_PROVIDERS"]) {
      expect(docs).toContain(variable);
      expect(env).toContain(`${variable}=`);
    }

    // The OAuth/webhook era is gone from every operator surface. ("webhook"
    // itself may appear only to say the deployment has none.)
    for (const retired of [
      "ATLASSIAN_OAUTH_CLIENT_ID", "ATLASSIAN_OAUTH_CLIENT_SECRET", "ATLASSIAN_OAUTH_REDIRECT_URI",
      "ATLASSIAN_ALLOWED_CLOUD_IDS", "ITESTFLOW_PUBLIC_URL", "read:me", "manage:jira-webhook",
      "offline_access", "User Identity API",
    ]) {
      expect(docs).not.toContain(retired);
      expect(env).not.toContain(retired);
    }
    for (const retired of ["ATLASSIAN_OAUTH", "ATLASSIAN_ALLOWED_CLOUD_IDS", "ITESTFLOW_PUBLIC_URL", "User Identity API"]) {
      expect(deployment).not.toContain(retired);
      expect(readme).not.toContain(retired);
    }

    expect(docs).toContain("Plain Jira");
    expect(docs).toContain("Xray Cloud");
    expect(docs).toContain("Zephyr Scale Cloud");

    // Identity continuity: the stable account id is the provider subject and
    // seeded owners reconcile without duplication.
    expect(docs).toContain("accountId");
    expect(docs).toContain("provider_subject");
    expect(docs).toMatch(/no duplicate (?:user|identity)/i);

    // Fresh-install contract and its single upgrade carve-out.
    expect(docs).toMatch(/fresh Jira Cloud deployment[^.]*BOOTSTRAP_JIRA_SITES[^.]*owner/i);
    expect(docs).toMatch(/optional only[^.]*upgrade[^.]*active jira-cloud workspace/i);
    expect(deployment).toMatch(/fresh Jira Cloud deployment[^.]*BOOTSTRAP_JIRA_SITES[^.]*owner/i);
    expect(readme).toMatch(/fresh Jira Cloud deployment[^.]*BOOTSTRAP_JIRA_SITES[^.]*owner/i);
    expect(env).toMatch(/Fresh Jira Cloud deployments[^\n]*BOOTSTRAP_JIRA_SITES/i);
    expect(env).toMatch(/optional only[\s\S]{0,160}active jira-cloud workspace/i);
    const bootstrapChecklist = deployment
      .split(/\r?\n/)
      .find((line) => line.startsWith("- [ ]") && line.includes("BOOTSTRAP_JIRA_SITES"));
    expect(bootstrapChecklist).toMatch(/unless[^.]*upgrade[^.]*active jira-cloud workspace/i);

    // The ordered rename runbook: update env, restart, sign in.
    const renameSection = docs.slice(
      docs.indexOf("### Renaming a Jira Site URL"),
      docs.indexOf("## Connect-to-Disconnect Flow"),
    );
    expect(renameSection.indexOf("Update `BOOTSTRAP_JIRA_SITES`")).toBeGreaterThan(-1);
    expect(renameSection.indexOf("Update `BOOTSTRAP_JIRA_SITES`")).toBeLessThan(renameSection.indexOf("Restart the application"));
    expect(renameSection.indexOf("Restart the application")).toBeLessThan(renameSection.indexOf("next successful sign-in"));

    // Polling replaces webhooks; credential-health recovery is actionable.
    expect(docs).toMatch(/polling/i);
    expect(docs).toContain("Sync now");
    expect(docs).toContain("Retry-After");
    expect(docs).toContain("jira_sync_principal_missing");
    expect(docs).toContain("jira_sync_principal_invalid");
    expect(docs).toMatch(/replace[^.]*token[^.]*Settings/i);

    // Reverse-proxy guidance for the Origin/Host login-CSRF guard.
    expect(docs).toMatch(/Origin[\s\S]{0,200}Host/);
    expect(docs).toContain("RATE_LIMIT_TRUSTED_PROXY_HOPS");

    // Rollback states exactly what the destructive migration's down() restores.
    expect(docs).toMatch(/downgrade recreates[^.]*empty/i);
    expect(docs).toMatch(/not recoverable/i);

    // Never ship a literal example secret.
    expect(docs).not.toMatch(/(client_secret|api_token|access_token)\s*=\s*[^<\s]/i);
  });
});
