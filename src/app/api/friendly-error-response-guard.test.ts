import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const unsafeResponsePatterns = [
  /NextResponse\.json\(\s*\{\s*error\s*:\s*error instanceof Error \? error\.message/,
  /NextResponse\.json\(\s*\{\s*error\s*:\s*error\.message/,
];

describe("API friendly error response guard", () => {
  it("does not return raw error.message directly from route responses", () => {
    const apiRoot = join(process.cwd(), "src", "app", "api");
    const offenders = routeFiles(apiRoot).flatMap((file) => {
      const source = readFileSync(file, "utf8");
      return unsafeResponsePatterns.some((pattern) => pattern.test(source))
        ? [relative(process.cwd(), file)]
        : [];
    });

    expect(offenders).toEqual([]);
  });
});

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) return routeFiles(path);
    return entry === "route.ts" ? [path] : [];
  });
}
