import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";
import { describe, expect, it } from "vitest";

const API_ROOT = join(process.cwd(), "src", "app", "api");
const PUBLIC_ROUTES = new Set([
  "auth/login/route.ts",
  "auth/logout/route.ts",
  "auth/organizations/route.ts",
  "auth/session/route.ts",
  "health/route.ts",
]);

const AUTH_MARKERS = [
  "requireWorkflowContext",
  "resolveWorkspaceRequest",
  "requireSession",
  "getCurrentSession",
  "requireWorkspaceAccess",
  "requireWorkspaceRole",
  // Source-document routes centralize the same workflow membership check in
  // document-route-helpers so every upload/download variant cannot drift.
  "resolveDocumentReadScope",
  "resolveDocumentMutationScope",
  // Egress-rule routes centralize the owner/admin check in egress-admin so
  // the list/create and update/delete variants cannot drift.
  "requireEgressAdmin",
];

function resolvesTrustedProjectScope(text: string) {
  return (
    (text.includes("requireWorkflowContext") && text.includes("resolveProjectScope"))
    || text.includes("resolveDocumentReadScope")
    || text.includes("resolveDocumentMutationScope")
  );
}

const KNOWLEDGE_BUILD_ROUTES = [
  "context/index/route.ts",
  "context/knowledge/manual/draft/route.ts",
  "context/knowledge/manual/finalize/route.ts",
  "context/knowledge/manual/validate/route.ts",
  "context/knowledge/promote/route.ts",
];

const EXTERNAL_LLM_MANUAL_ROUTES = [
  "requirement-analysis/manual/draft/route.ts",
  "requirement-analysis/manual/submit/route.ts",
  "test-cases/manual/draft/route.ts",
  "test-cases/manual/submit/route.ts",
  "existing-test-case-review/manual/draft/route.ts",
  "existing-test-case-review/manual/submit/route.ts",
  "bugs/manual/draft/route.ts",
  "bugs/manual/submit/route.ts",
  "test-execution-effort/external-prompt/route.ts",
  "test-execution-effort/manual/submit/route.ts",
  "context/knowledge/manual/draft/route.ts",
  "context/knowledge/manual/validate/route.ts",
  "context/knowledge/manual/finalize/route.ts",
];

const WORKSPACE_ADMIN_ROUTES = [
  "workspace/members/[membershipId]/route.ts",
  "workspace/settings/route.ts",
  "workspace/sync/route.ts",
  "workspace/sync-credential/route.ts",
  "workspace/sync-schedule/route.ts",
];

function routeFiles(dir = API_ROOT): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return routeFiles(path);
    return entry === "route.ts" ? [path] : [];
  });
}

function apiRelative(path: string) {
  return relative(API_ROOT, path).replace(/\\/g, "/");
}

describe("API route guards", () => {
  it("keeps every non-public route behind an auth primitive", () => {
    const unguarded = routeFiles()
      .map((path) => ({ path, text: readFileSync(path, "utf8") }))
      .filter(({ path, text }) => !PUBLIC_ROUTES.has(apiRelative(path)) && !AUTH_MARKERS.some((marker) => text.includes(marker)))
      .map(({ path }) => apiRelative(path));

    expect(unguarded).toEqual([]);
  });

  it("resolves server-trusted project scope in project-scoped routes", () => {
    const missingResolver = routeFiles()
      .map((path) => ({ path, text: readFileSync(path, "utf8") }))
      .filter(({ text }) => text.includes("ProjectScopeSchema"))
      .filter(({ text }) => !resolvesTrustedProjectScope(text))
      .map(({ path }) => apiRelative(path));

    expect(missingResolver).toEqual([]);
  });

  // INV-2: the RAW client scope (`parsed.data.scope`) may only be used to (a) read the
  // workspace hint and (b) feed resolveProjectScope. It must never flow into an adapter
  // or feature service — those take the resolved, server-trusted scope. We strip the
  // allowed uses and assert nothing references the raw client scope afterward.
  it("never passes the raw client scope into an adapter or feature service", () => {
    const offenders = routeFiles()
      .map((path) => ({ path, text: readFileSync(path, "utf8") }))
      .filter(({ text }) => text.includes("ProjectScopeSchema"))
      .filter(({ text }) => {
        const stripped = text
          .replace(/(?:resolveProjectScope|resolveDocumentReadScope|resolveDocumentMutationScope)\([^)]*\)/g, "") // trusted resolver calls consume the raw scope
          .replace(/parsed\.data\.scope\??\.\w+/g, "") // workspace-hint access: parsed.data.scope(?.)workspaceId
          .replace(/parsed\.data\.scope\s*(\?(?!\.)|&&|\|\|)/g, ""); // truthiness guards: scope ?  / &&  / ||
        return stripped.includes("parsed.data.scope");
      })
      .map(({ path }) => apiRelative(path));

    // A non-empty list means a route forwards untrusted client scope downstream.
    expect(offenders).toEqual([]);
  });

  it("keeps document scope helpers chained to workflow auth and canonical scope resolution", () => {
    const text = readFileSync(join(API_ROOT, "context/documents/document-route-helpers.ts"), "utf8");

    expect(text).toContain("await requireWorkflowContext(scopeInput.workspaceId)");
    expect(text).toContain("await resolveProjectScope(ctx, scopeInput)");
    expect(text).toContain('await requireWorkflowRole(context.ctx, ["owner", "admin"], message)');
  });

  it("keeps the egress-admin helper chained to workflow auth and the owner/admin role", () => {
    const text = readFileSync(join(API_ROOT, "test-execution/egress-rules/egress-admin.ts"), "utf8");

    expect(text).toContain("await requireWorkflowContext(workspaceId)");
    expect(text).toContain(`["owner", "admin"]`);
    expect(text).toContain("requireWorkflowRole");
  });

  it("keeps knowledge build routes limited to owner/admin roles", () => {
    const missingRoleGuard = KNOWLEDGE_BUILD_ROUTES
      .map((route) => ({ route, text: readFileSync(join(API_ROOT, route), "utf8") }))
      .filter(({ text }) => !text.includes("requireWorkflowRole") || !text.includes(`["owner", "admin"]`))
      .map(({ route }) => route);

    expect(missingRoleGuard).toEqual([]);
  });

  it("keeps every manual External LLM endpoint behind the workspace capability guard", () => {
    const missingExternalLlmGuard = EXTERNAL_LLM_MANUAL_ROUTES.filter((route) => {
      const text = readFileSync(join(API_ROOT, route), "utf8");
      const contextGuard = text.indexOf("await requireWorkflowContext(");
      const externalLlmGuard = text.indexOf("await requireExternalLlmEnabled(");
      return contextGuard < 0 || externalLlmGuard < 0 || externalLlmGuard < contextGuard;
    });

    expect(missingExternalLlmGuard).toEqual([]);
  });

  it("checks the Knowledge Hub role before the External LLM capability", () => {
    const knowledgeRoutes = EXTERNAL_LLM_MANUAL_ROUTES.filter((route) => route.startsWith("context/knowledge/"));
    const invalidOrder = knowledgeRoutes.filter((route) => {
      const text = readFileSync(join(API_ROOT, route), "utf8");
      const roleGuard = text.indexOf("await requireWorkflowRole(");
      const externalLlmGuard = text.indexOf("await requireExternalLlmEnabled(");
      return roleGuard < 0 || externalLlmGuard < 0 || roleGuard > externalLlmGuard;
    });

    expect(invalidOrder).toEqual([]);
  });

  it("keeps workspace administration routes limited to owner/admin roles", () => {
    const missingRoleGuard = WORKSPACE_ADMIN_ROUTES
      .map((route) => ({ route, text: readFileSync(join(API_ROOT, route), "utf8") }))
      .filter(({ text }) => !text.includes(`resolveWorkspaceRequest(["owner", "admin"])`))
      .map(({ route }) => route);

    expect(missingRoleGuard).toEqual([]);
  });

  it("keeps the workspace member roster visible to active workspace members", () => {
    const text = readFileSync(join(API_ROOT, "workspace/members/route.ts"), "utf8");

    expect(text).toContain("resolveWorkspaceRequest()");
    expect(text).not.toContain(`resolveWorkspaceRequest(["owner", "admin"])`);
  });

  it("keeps workspace capabilities visible to active workspace members", () => {
    const text = readFileSync(join(API_ROOT, "workspace/capabilities/route.ts"), "utf8");

    expect(text).toContain("resolveWorkspaceRequest()");
    expect(text).toContain("resolveWorkspaceRequestForWorkspace(requestedWorkspaceId)");
    expect(text).not.toContain(`resolveWorkspaceRequest(["owner", "admin"])`);
  });
});
