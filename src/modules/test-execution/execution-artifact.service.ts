import "server-only";

import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { createId, nowIso, sqlGet, sqlRun } from "@/modules/shared/infrastructure/database/db";
import { LocalFilesystemStorageBackend } from "@/modules/documents/storage/local-filesystem-backend";
import { sanitizeExecutionPayload } from "./execution-redaction";

const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;

export function artifactUrls(value: unknown): string[] {
  const urls = new Set<string>();
  function visit(node: unknown) {
    if (typeof node === "string" && /^https?:\/\//i.test(node) && /(?:trace|\.zip(?:\?|$))/i.test(node)) urls.add(node);
    else if (Array.isArray(node)) node.forEach(visit);
    else if (node && typeof node === "object") Object.values(node).forEach(visit);
  }
  visit(value);
  return [...urls];
}

export function resolveProtectedArtifactUrl(baseUrl: string, candidate: string): URL {
  const base = new URL(baseUrl);
  const resolved = new URL(candidate, base);
  if (base.username || base.password || resolved.username || resolved.password) {
    throw new Error("Playwright MCP artifact URLs may not contain credentials.");
  }
  if (/%(?:2f|5c)/i.test(resolved.pathname)
    || resolved.origin !== base.origin
    || !resolved.pathname.startsWith(base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`)) {
    throw new Error("Playwright MCP artifact URL is outside the configured artifact base URL.");
  }
  return resolved;
}

function durableArtifactSourceUrl(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Playwright MCP artifact source URL is invalid.");
  }
  return `${url.origin}${url.pathname}`;
}

export async function importHttpArtifact(input: {
  workspaceId: string; runId: string; caseId?: string; stepId?: string;
  sourceUrl: string; artifactBaseUrl: string; bearerToken?: string | null;
  kind: "screenshot" | "trace" | "video" | "log";
}): Promise<string> {
  const url = resolveProtectedArtifactUrl(input.artifactBaseUrl, input.sourceUrl);
  const response = await fetch(url, {
    headers: input.bearerToken ? { Authorization: `Bearer ${input.bearerToken}` } : undefined,
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok || !response.body) throw new Error(`Playwright MCP artifact download failed with HTTP ${response.status}.`);
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_ARTIFACT_BYTES) throw new Error("Playwright MCP artifact exceeds the 100 MiB limit.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_ARTIFACT_BYTES) {
      await reader.cancel();
      throw new Error("Playwright MCP artifact exceeds the 100 MiB limit.");
    }
    chunks.push(value);
  }
  const bytes = Buffer.concat(chunks, total);
  return storeArtifactBytes({ ...input, bytes, mimeType: response.headers.get("content-type") ?? "application/octet-stream", sourceUrl: url.toString() });
}

export async function storeArtifactBytes(input: {
  workspaceId: string; runId: string; caseId?: string; stepId?: string;
  bytes: Uint8Array; mimeType: string; sourceUrl?: string | null;
  kind: "screenshot" | "trace" | "video" | "log";
}): Promise<string> {
  const bytes = input.bytes;
  if (bytes.byteLength > MAX_ARTIFACT_BYTES) throw new Error("Playwright MCP artifact exceeds the 100 MiB limit.");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const stored = await new LocalFilesystemStorageBackend().put({
    workspaceId: input.workspaceId, contentSha256: sha256,
    content: Readable.from(bytes), expectedByteSize: bytes.byteLength,
  });
  const id = createId("pwart");
  await sqlRun(`INSERT INTO playwright_execution_artifacts
    (id, workspace_id, run_id, case_id, step_id, kind, sha256, storage_key, mime_type, byte_size, source_url, created_at)
    VALUES (@id, @workspaceId, @runId, @caseId, @stepId, @kind, @sha256, @storageKey, @mimeType, @byteSize, @sourceUrl, @now)`, {
    id, workspaceId: input.workspaceId, runId: input.runId, caseId: input.caseId ?? null, stepId: input.stepId ?? null,
    kind: input.kind, sha256, storageKey: stored.storageKey,
    mimeType: input.mimeType, byteSize: bytes.byteLength,
    sourceUrl: input.sourceUrl ? durableArtifactSourceUrl(input.sourceUrl) : null, now: nowIso(),
  });
  return id;
}

export async function importInlineMcpArtifacts(input: {
  workspaceId: string; runId: string; caseId: string; stepId: string; toolName: string; result: unknown;
  /** Set false (screenshot policy "none") to skip persisting inline image blocks. */
  persistInlineScreenshots?: boolean;
  /** Run secret values scrubbed from persisted textual artifacts (console logs). */
  secrets?: readonly string[];
}): Promise<string[]> {
  const ids: string[] = [];
  const content = input.result && typeof input.result === "object" && "content" in input.result
    ? (input.result as { content?: unknown }).content : undefined;
  if (Array.isArray(content) && input.persistInlineScreenshots !== false) {
    for (const block of content) {
      if (block && typeof block === "object" && (block as { type?: unknown }).type === "image" && typeof (block as { data?: unknown }).data === "string") {
        const mimeType = typeof (block as { mimeType?: unknown }).mimeType === "string" ? (block as { mimeType: string }).mimeType : "image/png";
        ids.push(await storeArtifactBytes({ ...input, kind: "screenshot", bytes: Buffer.from((block as { data: string }).data, "base64"), mimeType }));
      }
    }
  }
  if (input.toolName === "browser_console_messages") {
    const bytes = Buffer.from(`${JSON.stringify(sanitizeExecutionPayload(input.result, input.secrets ?? []), null, 2)}\n`, "utf8");
    ids.push(await storeArtifactBytes({ ...input, kind: "log", bytes, mimeType: "application/json" }));
  }
  return ids;
}

export async function getExecutionArtifact(id: string, workspaceId: string, projectId: string) {
  return (await sqlGet<{ storage_key: string; mime_type: string; byte_size: number }>(
    `SELECT a.storage_key, a.mime_type, a.byte_size FROM playwright_execution_artifacts a
       JOIN playwright_execution_runs r ON r.id = a.run_id
      WHERE a.id = @id AND a.workspace_id = @workspaceId AND r.project_id = @projectId`,
    { id, workspaceId, projectId },
  )) ?? null;
}
