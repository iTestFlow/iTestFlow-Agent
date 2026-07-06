import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { COVERAGE_EXCLUDE, GATED_INCLUDE } from "../../vitest.coverage-manifest";

/**
 * Shared logic for the coverage-gate guard tests (see coverage-manifest.integrity.test.ts).
 *
 * The risk-based gate (vitest.coverage.config.ts) enforces thresholds on a curated
 * allowlist of high-risk source files. To stop that allowlist from silently going stale
 * as the codebase grows, the guard requires every "logic" source file to be EITHER gated
 * OR explicitly listed in the committed ungated inventory. A new file matching neither
 * fails CI, forcing a conscious "gate it or acknowledge it" decision.
 */
export const ROOT = process.cwd();

/** Committed inventory of logic files intentionally left OUT of the gate. */
export const UNGATED_INVENTORY_REL = "src/test/coverage-ungated.json";
const UNGATED_INVENTORY = path.join(ROOT, UNGATED_INVENTORY_REL);

/**
 * The "logic universe" the guard governs: server-side / logic source that can carry
 * correctness, security, or isolation bugs. This is deliberately BROADER than the broad
 * coverage report's roots (vitest.coverage-all.config.ts) — it intentionally includes the
 * API route layer (the primary project-isolation/auth surface), middleware, shared libs,
 * the worker, and ops scripts so a NEW high-risk file there cannot escape the
 * gate-or-acknowledge decision. Purely presentational code (src/app pages/layouts, React
 * components outside src/components/workflow) is out of scope by design — it is not a root.
 */
const UNIVERSE: Array<{ root: string; exts: string[]; recursive?: boolean }> = [
  { root: "src/modules", exts: [".ts"] },
  { root: "src/lib", exts: [".ts"] },
  { root: "src/shared", exts: [".ts"] },
  { root: "src/worker", exts: [".ts"] },
  { root: "src/scripts", exts: [".ts"] },
  // Repo-root ops/CI scripts (e.g. render-vitest-summary.ts) — same gate-or-acknowledge
  // decision as src/scripts; .mjs launchers are out of scope.
  { root: "scripts", exts: [".ts"] },
  { root: "src/components/workflow", exts: [".ts", ".tsx"] },
  { root: "src/app/api", exts: [".ts"] },
  { root: "src/app/test-gap-analysis/lib", exts: [".ts"] },
  // Top-level entrypoints only (e.g. middleware.ts, instrumentation*.ts) — NOT recursive,
  // so this does not pull in the rest of src/.
  { root: "src", exts: [".ts"], recursive: false },
];

/** Compile a coverage-style glob (supports `**`, single `*`, and `{a,b}` braces) to a full-path RegExp. */
function globToRegExp(glob: string): RegExp {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i += 1;
        if (glob[i + 1] === "/") {
          i += 1;
          re += "(?:.*/)?"; // `**/` spans zero or more path segments
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*"; // a single `*` stays within one path segment
      }
    } else if (c === "{") {
      const close = glob.indexOf("}", i);
      re += "(?:" + glob.slice(i + 1, close).split(",").map(esc).join("|") + ")";
      i = close;
    } else {
      re += esc(c);
    }
  }
  return new RegExp(re + "$");
}

// Applies the SAME exclude list vitest uses for coverage (shared via vitest.coverage-manifest),
// so the guard's "logic universe" excludes exactly what coverage excludes — no hand-mirroring drift.
const EXCLUDE_RX = COVERAGE_EXCLUDE.map(globToRegExp);

/** True if a file is excluded from coverage (and therefore not "logic" the guard must categorize). */
export function isExcluded(rel: string): boolean {
  return EXCLUDE_RX.some((rx) => rx.test(rel));
}

function walkFiles(absRoot: string, recursive: boolean): string[] {
  if (!existsSync(absRoot)) return [];
  return readdirSync(absRoot, { recursive, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

/** Production logic files (relative POSIX paths), excluding tests/types/excluded files. */
export function listLogicFiles(): string[] {
  const files = new Set<string>();
  for (const { root, exts, recursive = true } of UNIVERSE) {
    for (const abs of walkFiles(path.join(ROOT, root), recursive)) {
      const rel = path.relative(ROOT, abs).split(path.sep).join("/");
      if (!exts.some((ext) => rel.endsWith(ext))) continue;
      if (isExcluded(rel)) continue;
      files.add(rel);
    }
  }
  return [...files].sort();
}

/**
 * The gated allowlist — imported directly from the shared manifest (NOT parsed from config
 * source text), so the guard sees exactly what vitest.coverage.config.ts enforces.
 */
export function gatedIncludePatterns(): string[] {
  return GATED_INCLUDE;
}

/** Does an exact gated-manifest path match a relative file? */
export function patternMatches(pattern: string, rel: string): boolean {
  return pattern === rel;
}

export function isGated(rel: string, patterns: string[] = gatedIncludePatterns()): boolean {
  return patterns.some((pattern) => patternMatches(pattern, rel));
}

/** Does an exact gated-manifest path resolve to an existing source file? */
export function patternResolves(pattern: string): boolean {
  return existsSync(path.join(ROOT, pattern));
}

export function loadUngatedInventory(): string[] {
  if (!existsSync(UNGATED_INVENTORY)) return [];
  const parsed = JSON.parse(readFileSync(UNGATED_INVENTORY, "utf8")) as { ungated?: string[] };
  return parsed.ungated ?? [];
}
