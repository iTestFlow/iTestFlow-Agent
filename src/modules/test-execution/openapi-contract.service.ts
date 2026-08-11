import "server-only";

import { createHash } from "node:crypto";

import type { PoolClient } from "pg";

import { writeAuditLog } from "@/modules/audit/audit.service";
import {
  requestPinnedHttp,
  type PinnedHttpRequest,
} from "@/modules/integrations/api-automation/pinned-http-transport";
import type { ProjectScope } from "@/modules/projects/project-isolation.guard";
import {
  createId,
  nowIso,
  sqlGet,
  withTransaction,
} from "@/modules/shared/infrastructure/database/db";

import {
  assertTestExecutionEgressAllowed,
  TestExecutionEgressError,
} from "./egress-policy.service";
import {
  normalizeOpenApiDocument,
  OpenApiNormalizationError,
  type NormalizedOpenApiContract,
} from "./openapi-contract-normalizer";

export const MAX_OPENAPI_DOCUMENT_BYTES = 2 * 1024 * 1024;
const DEFAULT_OPENAPI_TIMEOUT_MS = 10_000;
const MAX_OPENAPI_TIMEOUT_MS = 60_000;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
let openApiTransport: PinnedHttpRequest = requestPinnedHttp;

export class OpenApiContractImportError extends Error {
  constructor(readonly clientMessage: string, readonly status = 422) {
    super(clientMessage);
    this.name = "OpenApiContractImportError";
  }
}

export type FrozenOpenApiContractResult = {
  revisionId: string;
  revision: number;
  operationCount: number;
  reused: boolean;
};

/** Fetch and reduce an untrusted same-origin document without persisting it. */
export async function fetchAndNormalizeSameOriginOpenApi(input: {
  workspaceId: string;
  baseUrl: string;
  sourceUrl: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<NormalizedOpenApiContract> {
  const { source } = validateSameOriginUrls(input.baseUrl, input.sourceUrl);
  if (input.signal?.aborted) {
    throw new OpenApiContractImportError("OpenAPI discovery was canceled.", 408);
  }
  let authorizedAddress: string;
  try {
    const authorization = await assertTestExecutionEgressAllowed({
      workspaceId: input.workspaceId,
      targetKind: "openapi",
      protocol: source.protocol === "https:" ? "https" : "http",
      host: source.hostname,
      port: effectivePort(source),
    });
    authorizedAddress = authorization.resolvedAddresses[0] ?? "";
    if (!authorizedAddress) {
      throw new OpenApiContractImportError("The OpenAPI target could not be resolved safely.", 403);
    }
  } catch (error) {
    if (error instanceof OpenApiContractImportError) throw error;
    if (error instanceof TestExecutionEgressError) {
      throw new OpenApiContractImportError(
        "The OpenAPI URL is not allowed by the workspace egress policy.",
        403,
      );
    }
    throw error;
  }
  if (input.signal?.aborted) {
    throw new OpenApiContractImportError("OpenAPI discovery was canceled.", 408);
  }

  const timeoutMs = normalizeTimeout(input.timeoutMs);
  const timeoutController = new AbortController();
  const timer = setTimeout(
    () => timeoutController.abort(new DOMException("OpenAPI discovery timed out.", "TimeoutError")),
    timeoutMs,
  );
  const signal = input.signal
    ? AbortSignal.any([input.signal, timeoutController.signal])
    : timeoutController.signal;
  try {
    const response = await openApiTransport(source, {
      method: "GET",
      headers: { Accept: "application/json, application/*+json" },
      redirect: "manual",
      credentials: "omit",
      cache: "no-store",
      signal,
    }, authorizedAddress);
    if (response.status >= 300 && response.status < 400) {
      throw new OpenApiContractImportError("OpenAPI discovery redirects are not allowed.");
    }
    if (!response.ok) {
      throw new OpenApiContractImportError(
        `The OpenAPI URL returned HTTP ${response.status}.`,
        502,
      );
    }
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (contentType && !contentType.includes("application/json") && !contentType.includes("+json")) {
      throw new OpenApiContractImportError("The OpenAPI URL must return a JSON document.");
    }
    const body = await readBoundedResponse(response);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new OpenApiContractImportError("The OpenAPI URL did not return valid JSON.");
    }
    try {
      return normalizeOpenApiDocument(parsed);
    } catch (error) {
      if (error instanceof OpenApiNormalizationError) {
        throw new OpenApiContractImportError(error.clientMessage);
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof OpenApiContractImportError) throw error;
    if (input.signal?.aborted) {
      throw new OpenApiContractImportError("OpenAPI discovery was canceled.", 408);
    }
    if (timeoutController.signal.aborted) {
      throw new OpenApiContractImportError("OpenAPI discovery timed out.", 504);
    }
    throw new OpenApiContractImportError("The OpenAPI document could not be fetched safely.", 502);
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch, normalize, and freeze or reuse an immutable project-scoped revision. */
export async function freezeSameOriginOpenApiContract(input: {
  workspaceId: string;
  scope: ProjectScope;
  actor: string;
  baseUrl: string;
  sourceUrl: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<FrozenOpenApiContractResult> {
  const { source } = validateSameOriginUrls(input.baseUrl, input.sourceUrl);
  const normalized = await fetchAndNormalizeSameOriginOpenApi(input);
  const normalizedJson = stableJson(normalized);
  const contentHash = sha256(normalizedJson);
  const stableKey = `openapi.url.${sha256(source.toString()).slice(0, 48)}`;
  const result = await withTransaction(async (client) => {
    await lockContractIdentity(client, input.workspaceId, input.scope, stableKey);
    const existing = await sqlGet<{ id: string; revision: number; operation_count: number }>(
      `SELECT id, revision, operation_count
       FROM test_api_contract_revisions
       WHERE workspace_id = @workspaceId AND project_id = @projectId
         AND azure_project_id = @azureProjectId AND stable_key = @stableKey
         AND content_hash = @contentHash
       ORDER BY revision DESC LIMIT 1`,
      {
        ...scopeParams(input.workspaceId, input.scope),
        stableKey,
        contentHash,
      },
      client,
    );
    if (existing) {
      return {
        revisionId: existing.id,
        revision: existing.revision,
        operationCount: existing.operation_count,
        reused: true,
      };
    }

    const latest = await sqlGet<{ revision: number }>(
      `SELECT revision FROM test_api_contract_revisions
       WHERE workspace_id = @workspaceId AND project_id = @projectId
         AND azure_project_id = @azureProjectId AND stable_key = @stableKey
       ORDER BY revision DESC LIMIT 1`,
      { ...scopeParams(input.workspaceId, input.scope), stableKey },
      client,
    );
    const id = createId("tacr");
    const revision = (latest?.revision ?? 0) + 1;
    const now = nowIso();
    const inserted = await sqlGet<{ id: string }>(
      `INSERT INTO test_api_contract_revisions (
         id, workspace_id, project_id, azure_project_id, stable_key,
         display_name, revision, source_kind, source_url, content_hash,
         normalized_spec_json, operation_count, created_by, created_at
       ) VALUES (
         @id, @workspaceId, @projectId, @azureProjectId, @stableKey,
         @displayName, @revision, 'same_origin_url', @sourceUrl, @contentHash,
         @normalizedSpecJson::jsonb, @operationCount, @actor, @now
       ) RETURNING id`,
      {
        id,
        ...scopeParams(input.workspaceId, input.scope),
        stableKey,
        displayName: contractDisplayName(source),
        revision,
        sourceUrl: source.toString(),
        contentHash,
        normalizedSpecJson: normalizedJson,
        operationCount: normalized.operations.length,
        actor: input.actor,
        now,
      },
      client,
    );
    if (!inserted) {
      throw new OpenApiContractImportError("The OpenAPI revision could not be frozen.", 500);
    }
    return {
      revisionId: id,
      revision,
      operationCount: normalized.operations.length,
      reused: false,
    };
  });

  if (!result.reused) {
    writeAuditLog({
      workspaceId: input.workspaceId,
      projectId: input.scope.projectId,
      azureProjectId: input.scope.azureProjectId,
      azureProjectName: input.scope.azureProjectName,
      azureOrganizationUrl: input.scope.azureOrganizationUrl,
      entityType: "test_api_contract_revision",
      entityId: result.revisionId,
      action: "test_execution.openapi_contract_frozen",
      status: "Success",
      actor: input.actor,
      message: `OpenAPI contract revision ${result.revision} frozen with ${result.operationCount} read-only operations.`,
      details: { sourceOrigin: source.origin, sourcePath: source.pathname },
    });
  }
  return result;
}

/** Test seam; pass null to restore the platform fetch implementation. */
export function setOpenApiContractFetchForTests(fetchImpl: FetchLike | null): void {
  openApiTransport = fetchImpl
    ? ((url, init) => fetchImpl(url, init))
    : requestPinnedHttp;
}

async function readBoundedResponse(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_OPENAPI_DOCUMENT_BYTES) {
    throw new OpenApiContractImportError(
      `The OpenAPI document exceeds the ${MAX_OPENAPI_DOCUMENT_BYTES}-byte limit.`,
      413,
    );
  }
  if (!response.body) throw new OpenApiContractImportError("The OpenAPI response body is empty.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_OPENAPI_DOCUMENT_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new OpenApiContractImportError(
        `The OpenAPI document exceeds the ${MAX_OPENAPI_DOCUMENT_BYTES}-byte limit.`,
        413,
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

function validateSameOriginUrls(baseValue: string, sourceValue: string): { base: URL; source: URL } {
  let base: URL;
  let source: URL;
  try {
    base = new URL(baseValue);
    source = new URL(sourceValue);
  } catch {
    throw new OpenApiContractImportError("Use valid HTTP or HTTPS API and OpenAPI URLs.");
  }
  if (
    !["http:", "https:"].includes(base.protocol) ||
    !["http:", "https:"].includes(source.protocol) ||
    base.username || base.password || source.username || source.password
  ) {
    throw new OpenApiContractImportError("OpenAPI discovery URLs must use HTTP or HTTPS without credentials.");
  }
  if (source.origin !== base.origin) {
    throw new OpenApiContractImportError("The OpenAPI URL must use the configured API base URL origin.");
  }
  if (source.search || source.hash) {
    throw new OpenApiContractImportError("The OpenAPI URL must not contain query parameters or a fragment.");
  }
  return { base, source };
}

function normalizeTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_OPENAPI_TIMEOUT_MS;
  if (!Number.isFinite(value)) return DEFAULT_OPENAPI_TIMEOUT_MS;
  return Math.max(1, Math.min(Math.trunc(value), MAX_OPENAPI_TIMEOUT_MS));
}

function effectivePort(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

function scopeParams(workspaceId: string, scope: ProjectScope) {
  return {
    workspaceId,
    projectId: scope.projectId,
    azureProjectId: scope.azureProjectId,
  };
}

async function lockContractIdentity(
  client: PoolClient,
  workspaceId: string,
  scope: ProjectScope,
  stableKey: string,
): Promise<void> {
  await sqlGet(
    `SELECT pg_advisory_xact_lock(hashtext(@lockKey))`,
    { lockKey: `${workspaceId}:${scope.projectId}:${scope.azureProjectId}:${stableKey}` },
    client,
  );
}

function contractDisplayName(source: URL): string {
  return `OpenAPI ${source.host}${source.pathname}`.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 200);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortJson(entry)]),
    );
  }
  return value;
}
