import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";
import { describe, expect, it } from "vitest";

const API_ROOT = join(process.cwd(), "src", "app", "api");
const PUBLIC_ROUTES = new Set([
  "auth/login/route.ts",
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
      .filter(({ text }) => !text.includes("requireWorkflowContext") || !text.includes("resolveProjectScope"))
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
          .replace(/resolveProjectScope\([^)]*\)/g, "") // the trusted resolver call (consumes the raw scope)
          .replace(/parsed\.data\.scope\??\.\w+/g, "") // workspace-hint access: parsed.data.scope(?.)workspaceId
          .replace(/parsed\.data\.scope\s*(\?(?!\.)|&&|\|\|)/g, ""); // truthiness guards: scope ?  / &&  / ||
        return stripped.includes("parsed.data.scope");
      })
      .map(({ path }) => apiRelative(path));

    // A non-empty list means a route forwards untrusted client scope downstream.
    expect(offenders).toEqual([]);
  });
});
