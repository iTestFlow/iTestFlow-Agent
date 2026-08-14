import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

// The operational helper is intentionally plain ESM so Node can run it without a build.
// @ts-expect-error JavaScript operational script has no declaration file.
import { currentRevision, graphCacheDirectory, repositoryIdentity, resolveFreshGraph } from "../../scripts/graphify-cache.mjs";

describe("Graphify exact-revision cache", () => {
  const originalCacheRoot = process.env.ITESTFLOW_GRAPHIFY_CACHE_ROOT;
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    if (originalCacheRoot === undefined) delete process.env.ITESTFLOW_GRAPHIFY_CACHE_ROOT;
    else process.env.ITESTFLOW_GRAPHIFY_CACHE_ROOT = originalCacheRoot;
    await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("derives a cache path from repository identity and the exact commit", async () => {
    const cacheRoot = await mkdtemp(path.join(os.tmpdir(), "itestflow-graph-cache-test-"));
    temporaryRoots.push(cacheRoot);
    process.env.ITESTFLOW_GRAPHIFY_CACHE_ROOT = cacheRoot;

    expect(graphCacheDirectory(process.cwd(), "abc123")).toBe(
      path.join(cacheRoot, ...repositoryIdentity(process.cwd()).split("/"), "abc123"),
    );
  });

  it("accepts only a graph marked for this repository and exact revision", async () => {
    const cacheRoot = await mkdtemp(path.join(os.tmpdir(), "itestflow-graph-cache-test-"));
    temporaryRoots.push(cacheRoot);
    process.env.ITESTFLOW_GRAPHIFY_CACHE_ROOT = cacheRoot;
    const revision = currentRevision(process.cwd());
    const directory = graphCacheDirectory(process.cwd(), revision);
    await mkdir(path.join(directory, "graphify-out"), { recursive: true });
    const graph = JSON.stringify({ nodes: [{ id: "root" }], edges: [] });
    await writeFile(path.join(directory, "graphify-out", "graph.json"), graph);
    await writeFile(path.join(directory, "itestflow-graphify-marker.json"), JSON.stringify({
      repository: repositoryIdentity(process.cwd()),
      revision,
      graphSha256: createHash("sha256").update(graph).digest("hex"),
    }));

    expect(resolveFreshGraph(process.cwd(), revision)).toBe(path.join(directory, "graphify-out", "graph.json"));

    await writeFile(path.join(directory, "itestflow-graphify-marker.json"), JSON.stringify({
      repository: repositoryIdentity(process.cwd()),
      revision: "different",
      graphSha256: createHash("sha256").update(graph).digest("hex"),
    }));
    expect(() => resolveFreshGraph(process.cwd(), revision)).toThrow("identity mismatch");
  });

  it("rejects structurally invalid or digest-mismatched graph content", async () => {
    const cacheRoot = await mkdtemp(path.join(os.tmpdir(), "itestflow-graph-cache-test-"));
    temporaryRoots.push(cacheRoot);
    process.env.ITESTFLOW_GRAPHIFY_CACHE_ROOT = cacheRoot;
    const revision = currentRevision(process.cwd());
    const directory = graphCacheDirectory(process.cwd(), revision);
    await mkdir(path.join(directory, "graphify-out"), { recursive: true });
    await writeFile(path.join(directory, "graphify-out", "graph.json"), "{}");
    await writeFile(path.join(directory, "itestflow-graphify-marker.json"), JSON.stringify({
      repository: repositoryIdentity(process.cwd()), revision, graphSha256: "wrong",
    }));
    expect(() => resolveFreshGraph(process.cwd(), revision)).toThrow("invalid or empty");
  });
});
