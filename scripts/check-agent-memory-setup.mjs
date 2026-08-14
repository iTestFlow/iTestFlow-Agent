import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mcp = JSON.parse(readFileSync(".mcp.json", "utf8"));
const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
assert.equal(packageJson.scripts["check:agent-memory"], "node scripts/check-agent-memory-setup.mjs");
const readme = readFileSync("README.md", "utf8");
assert.match(readme, /uvx --from mempalace==3\.7\.0/, "README must document the exact pinned launcher");
assert.match(readme, /docs\.astral\.sh\/uv\/getting-started\/installation/, "README must link the authoritative uv prerequisite");
const mempalace = mcp.mcpServers["itestflow-mempalace"];
assert.equal(mempalace.command, "uvx", "MemPalace MCP must self-bootstrap through uvx");
assert.deepEqual(
  mempalace.args.slice(0, 3),
  ["--from", "mempalace==3.7.0", "mempalace-mcp"],
  "MemPalace MCP must pin its package and executable",
);

const taxonomy = readFileSync("mempalace.yaml", "utf8");
assert.match(taxonomy, /^- \.memory\/\*\*$/m, "all native Memory state must be excluded");
assert.doesNotMatch(taxonomy, /^- \.memory\/(?!\*\*$)/m, "do not enumerate partial Memory exclusions");
const toolingTaxonomy = taxonomy.match(/- name: tooling[\s\S]*?(?=\n- name:)/)?.[0] ?? "";
assert.doesNotMatch(toolingTaxonomy, /keywords:.*\b(private|license|test)\b/, "tooling taxonomy must not capture broad repository content");

const claude = readFileSync("CLAUDE.md", "utf8");
assert.ok(claude.length < 120, "CLAUDE.md must remain a thin adapter");
assert.match(claude, /Follow \[AGENTS\.md\]\(AGENTS\.md\)/, "CLAUDE.md must delegate to AGENTS.md");

const objectIds = new Set(readdirSync(".memory/memory", { recursive: true })
  .filter((path) => path.endsWith(".json"))
  .map((path) => JSON.parse(readFileSync(`.memory/memory/${path}`, "utf8")).id));
const verification = JSON.parse(readFileSync(".memory/memory/workflows/post-task-verification.json", "utf8"));
assert.equal(verification.facets.category, "convention", "verification workflow must also supply the quality bar role");
for (const redundant of [
  "synthesis.agent-knowledge-workflow",
  "synthesis.conventions-quality",
  "workflow.package-scripts",
  "source.docs-integration-providers",
  "source.package-lock-json",
]) {
  assert.ok(!objectIds.has(redundant), `remove redundant or vacuous ${redundant}`);
}

const sentinelRoot = mkdtempSync(join(tmpdir(), "itestflow-mempalace-check-"));
try {
  const sentinel = "native-memory-sentinel-4d342326.md";
  const control = "mine-control-4d342326.md";
  for (const path of [".memory", "docs", "src/app", "src/modules", "scripts"]) {
    mkdirSync(join(sentinelRoot, path), { recursive: true });
  }
  writeFileSync(join(sentinelRoot, "mempalace.yaml"), taxonomy);
  const fixtureBody = "deterministic fixture content ".repeat(12);
  writeFileSync(join(sentinelRoot, ".memory", sentinel), fixtureBody);
  writeFileSync(join(sentinelRoot, "docs", control), fixtureBody);
  writeFileSync(join(sentinelRoot, "src/app", "application-route-4d342326.ts"), fixtureBody);
  writeFileSync(join(sentinelRoot, "src/modules", "domain-route-4d342326.ts"), fixtureBody);
  writeFileSync(join(sentinelRoot, "scripts", "tooling-route-4d342326.js"), fixtureBody);
  const sentinelRun = spawnSync(
    "uvx",
    ["--from", "mempalace==3.7.0", "mempalace", "--palace", join(sentinelRoot, "palace"), "mine", sentinelRoot, "--dry-run", "--wing", "sentinel"],
    { encoding: "utf8", maxBuffer: 1024 * 1024 },
  );
  assert.equal(sentinelRun.status, 0, sentinelRun.stderr || "MemPalace sentinel dry-run failed");
  const sentinelOutput = `${sentinelRun.stdout}\n${sentinelRun.stderr}`.replace(/\x1b\[[0-9;]*m/g, "");
  for (const [file, room] of [
    [control, "docs"],
    ["application-route-4d342326.ts", "application"],
    ["domain-route-4d342326.ts", "domain"],
    ["tooling-route-4d342326.js", "tooling"],
  ]) {
    assert.match(sentinelOutput, new RegExp(`\\[DRY RUN\\] ${file.replaceAll(".", "\\.")} -> room:${room}\\b`), `${file} must route to ${room}`);
  }
  assert.doesNotMatch(sentinelOutput, new RegExp(sentinel), "dry-run must omit the .memory sentinel");
} finally {
  rmSync(sentinelRoot, { recursive: true, force: true });
}

console.log("agent memory setup structural checks passed");
