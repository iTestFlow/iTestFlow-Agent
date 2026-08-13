import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MARKER_NAME = "itestflow-graphify-marker.json";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    shell: false,
  });
  if (result.status !== 0) {
    const detail = options.capture ? `\n${result.stderr || result.stdout || ""}` : "";
    throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status}.${detail}`);
  }
  return options.capture ? result.stdout.trim() : "";
}

export function repositoryIdentity(root) {
  let remote;
  try {
    remote = run("git", ["-C", root, "remote", "get-url", "upstream"], { capture: true });
  } catch {
    remote = run("git", ["-C", root, "remote", "get-url", "origin"], { capture: true });
  }
  const match = remote.replace(/\.git$/i, "").match(/github\.com[/:]([^/]+)\/([^/]+)$/i);
  if (!match) throw new Error("Graphify cache requires an upstream or origin GitHub remote.");
  return `${match[1].toLowerCase()}/${match[2].toLowerCase()}`;
}

export function currentRevision(root) {
  return run("git", ["-C", root, "rev-parse", "HEAD"], { capture: true });
}

export function graphCacheRoot() {
  return path.resolve(
    process.env.ITESTFLOW_GRAPHIFY_CACHE_ROOT?.trim()
      || path.join(os.homedir(), ".cache", "itestflow-agent", "graphify"),
  );
}

export function graphCacheDirectory(root, revision = currentRevision(root)) {
  return path.join(graphCacheRoot(), ...repositoryIdentity(root).split("/"), revision);
}

function graphDigest(graphPath) {
  return createHash("sha256").update(readFileSync(graphPath)).digest("hex");
}

function validateGraphShape(graphPath) {
  const graph = JSON.parse(readFileSync(graphPath, "utf8"));
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges) || graph.nodes.length === 0) {
    throw new Error("Graphify cache graph.json has an invalid or empty graph structure.");
  }
}

export function resolveFreshGraph(root, revision = currentRevision(root)) {
  const directory = graphCacheDirectory(root, revision);
  const markerPath = path.join(directory, MARKER_NAME);
  const graphPath = path.join(directory, "graphify-out", "graph.json");
  if (!existsSync(markerPath) || !existsSync(graphPath)) {
    throw new Error(`Graphify cache is absent for ${revision}. Run npm run graph:refresh.`);
  }
  const marker = JSON.parse(readFileSync(markerPath, "utf8"));
  const expected = {
    repository: repositoryIdentity(root),
    revision,
  };
  if (marker.repository !== expected.repository || marker.revision !== expected.revision) {
    throw new Error(`Graphify cache identity mismatch for ${revision}.`);
  }
  validateGraphShape(graphPath);
  if (!marker.graphSha256 || marker.graphSha256 !== graphDigest(graphPath)) {
    throw new Error(`Graphify cache digest mismatch for ${revision}.`);
  }
  return graphPath;
}

async function acquirePublishLock(lockDirectory, root, revision) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      await mkdir(lockDirectory);
      return true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const lockStat = await stat(lockDirectory);
        if (Date.now() - lockStat.mtimeMs > 15 * 60 * 1000) {
          const staleLock = `${lockDirectory}.stale-${randomUUID()}`;
          await rename(lockDirectory, staleLock);
          await rm(staleLock, { recursive: true, force: true });
          continue;
        }
      } catch (lockError) {
        if (lockError?.code !== "ENOENT") throw lockError;
        continue;
      }
      try {
        resolveFreshGraph(root, revision);
        return false;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }
  throw new Error(`Timed out waiting for Graphify cache publication lock for ${revision}.`);
}

export async function refreshGraph(root) {
  const revision = currentRevision(root);
  try {
    return resolveFreshGraph(root, revision);
  } catch {
    // Build below. An exact revision is immutable, so an already-valid cache is reusable.
  }

  const cacheDirectory = graphCacheDirectory(root, revision);
  const cacheParent = path.dirname(cacheDirectory);
  await mkdir(cacheParent, { recursive: true });
  const lockDirectory = `${cacheDirectory}.lock`;
  const ownsLock = await acquirePublishLock(lockDirectory, root, revision);
  if (!ownsLock) return resolveFreshGraph(root, revision);
  try {
    const resolved = resolveFreshGraph(root, revision);
    await rm(lockDirectory, { recursive: true, force: true });
    return resolved;
  } catch {
    // The lock owner repairs invalid cache state below.
  }
  const staging = await mkdtemp(path.join(cacheParent, `${revision}.staging-`));
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "itestflow-graphify-"));
  const detachedWorktree = path.join(temporaryRoot, "repository");
  const quarantine = `${cacheDirectory}.invalid-${randomUUID()}`;
  let worktreeAdded = false;
  let quarantined = false;

  try {
    if (existsSync(cacheDirectory)) {
      await rename(cacheDirectory, quarantine);
      quarantined = true;
    }
    run("git", ["-C", root, "worktree", "add", "--detach", detachedWorktree, revision]);
    worktreeAdded = true;
    run("graphify", ["extract", detachedWorktree, "--code-only", "--no-cluster", "--out", staging]);
    const graphPath = path.join(staging, "graphify-out", "graph.json");
    if (!existsSync(graphPath)) throw new Error("Graphify did not produce graph.json.");
    validateGraphShape(graphPath);
    writeFileSync(path.join(staging, MARKER_NAME), `${JSON.stringify({
      repository: repositoryIdentity(root),
      revision,
      graphSha256: graphDigest(graphPath),
      generatedAt: new Date().toISOString(),
    }, null, 2)}\n`, { flag: "wx" });
    await rename(staging, cacheDirectory);
    if (quarantined) await rm(quarantine, { recursive: true, force: true });
    return resolveFreshGraph(root, revision);
  } finally {
    if (worktreeAdded) {
      try {
        run("git", ["-C", root, "worktree", "remove", "--force", detachedWorktree]);
      } catch (error) {
        console.warn(`Graphify worktree cleanup failed: ${error instanceof Error ? error.message : error}`);
      }
    }
    await Promise.allSettled([
      rm(temporaryRoot, { recursive: true, force: true }),
      rm(staging, { recursive: true, force: true }),
      rm(lockDirectory, { recursive: true, force: true }),
    ]);
  }
}

async function main() {
  const command = process.argv[2];
  const root = path.resolve(process.argv[3] || process.cwd());
  if (command === "resolve") {
    process.stdout.write(`${resolveFreshGraph(root)}\n`);
    return;
  }
  if (command === "refresh") {
    process.stdout.write(`${await refreshGraph(root)}\n`);
    return;
  }
  throw new Error("Usage: node scripts/graphify-cache.mjs <resolve|refresh> [repository-root]");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
