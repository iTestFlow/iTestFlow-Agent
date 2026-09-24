import "server-only";

import { isIP } from "node:net";

import { requestPinnedHttp } from "@/modules/integrations/api-automation/pinned-http-transport";

const MAX_DOCUMENT_BYTES = 1024 * 1024;
const MAX_OPERATIONS = 300;
const METHODS = ["get", "head", "post", "put", "patch", "delete"] as const;

export type OpenApiOperation = {
  operationId: string;
  method: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  pathParameters: string[];
  queryParameters: string[];
  requestBodyContentTypes: string[];
};

export class OpenApiDiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenApiDiscoveryError";
  }
}

/** A bounded, untrusted operation index. The original document never enters the model. */
export function normalizeOpenApiOperations(document: unknown): OpenApiOperation[] {
  const root = record(document);
  if (!root || typeof root.openapi !== "string" || !/^3\.(0|1)(?:\.\d+)?$/.test(root.openapi)) {
    throw new OpenApiDiscoveryError("The document must be OpenAPI 3 JSON.");
  }
  if (containsRemoteRef(root)) throw new OpenApiDiscoveryError("Remote OpenAPI references are unsupported.");
  const paths = record(root.paths);
  if (!paths) throw new OpenApiDiscoveryError("The OpenAPI document has no paths object.");
  const operations: OpenApiOperation[] = [];
  const ids = new Set<string>();
  for (const [path, value] of Object.entries(paths).sort(([a], [b]) => a.localeCompare(b))) {
    if (!safePath(path)) continue;
    const pathItem = record(value);
    if (!pathItem || "$ref" in pathItem) continue;
    for (const method of METHODS) {
      const operation = record(pathItem[method]);
      if (!operation || operation.deprecated === true) continue;
      if (operations.length >= MAX_OPERATIONS) throw new OpenApiDiscoveryError("The OpenAPI operation limit was exceeded.");
      const pathParameters = [...path.matchAll(/\{([A-Za-z_][A-Za-z0-9_]{0,63})\}/g)].map((match) => match[1]);
      const parameterEntries = [...array(pathItem.parameters), ...array(operation.parameters)];
      const queryParameters: string[] = [];
      for (const entry of parameterEntries) {
        const parameter = record(entry);
        if (!parameter || "$ref" in parameter || parameter.in !== "query" || !safeName(parameter.name)) continue;
        if (!queryParameters.includes(parameter.name as string)) queryParameters.push(parameter.name as string);
      }
      const requestBody = record(operation.requestBody);
      const content = record(requestBody?.content);
      const requestBodyContentTypes = content ? Object.keys(content).filter((type) => type === "application/json" || type === "application/x-www-form-urlencoded") : [];
      const preferred = typeof operation.operationId === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,119}$/.test(operation.operationId)
        ? operation.operationId : `${method.toUpperCase()} ${path}`;
      let operationId = preferred;
      for (let suffix = 2; ids.has(operationId); suffix += 1) operationId = `${preferred.slice(0, 115)}_${suffix}`;
      ids.add(operationId);
      operations.push({ operationId, method: method.toUpperCase() as OpenApiOperation["method"], path,
        pathParameters: [...new Set(pathParameters)], queryParameters: queryParameters.sort(), requestBodyContentTypes });
    }
  }
  if (operations.length === 0) throw new OpenApiDiscoveryError("The OpenAPI document has no importable operations.");
  return operations;
}

/** Fetch only the exact snapshotted URL through DNS authorization and a pinned socket. */
export async function discoverOpenApiOperations(
  value: string,
  authorizeTarget: (url: URL, kind: "openapi") => Promise<{ resolvedAddresses: string[] }>,
  signal: AbortSignal,
): Promise<OpenApiOperation[]> {
  let url: URL;
  try { url = new URL(value); } catch { throw new OpenApiDiscoveryError("The OpenAPI URL is invalid."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new OpenApiDiscoveryError("The OpenAPI URL must be HTTP(S) without credentials, query, or fragment.");
  }
  if (signal.aborted) throw new OpenApiDiscoveryError("OpenAPI discovery was canceled.");
  const authorization = await authorizeTarget(url, "openapi");
  const address = authorization.resolvedAddresses[0];
  if (!address || isIP(address) === 0) throw new OpenApiDiscoveryError("The OpenAPI target was not authorized.");
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("deadline exceeded")), 10_000);
  try {
    const response = await requestPinnedHttp({ url, address, method: "GET", headers: new Headers({ Accept: "application/json" }),
      maxResponseBytes: MAX_DOCUMENT_BYTES, signal: controller.signal });
    if (response.statusCode < 200 || response.statusCode >= 300 || response.truncated) {
      throw new OpenApiDiscoveryError("The OpenAPI document could not be loaded within its size limit.");
    }
    if (!/^(application\/json|application\/[\w.+-]+\+json)(?:\s*;|\s*$)/i.test(response.headers["content-type"] ?? "")) {
      throw new OpenApiDiscoveryError("The OpenAPI endpoint must return JSON.");
    }
    let document: unknown;
    try { document = JSON.parse(response.bytes.toString("utf8")); }
    catch { throw new OpenApiDiscoveryError("The OpenAPI endpoint returned invalid JSON."); }
    return normalizeOpenApiOperations(document);
  } catch (error) {
    if (error instanceof OpenApiDiscoveryError) throw error;
    throw new OpenApiDiscoveryError("The OpenAPI document could not be loaded.");
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function safeName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(value) && !/(secret|token|password|authorization|cookie|credential|api[_-]?key)/i.test(value);
}
function safePath(path: string): boolean {
  if (!path.startsWith("/") || path.startsWith("//") || path.length > 2000 || /[\\\s?#]/.test(path)) return false;
  const stripped = path.replace(/\{[A-Za-z_][A-Za-z0-9_]{0,63}\}/g, "");
  if (stripped.includes("{") || stripped.includes("}")) return false;
  try { return !decodeURIComponent(stripped).split("/").some((part) => part === "." || part === ".."); }
  catch { return false; }
}
function containsRemoteRef(value: unknown, depth = 0): boolean {
  if (depth > 64) return true;
  if (Array.isArray(value)) return value.some((entry) => containsRemoteRef(entry, depth + 1));
  const item = record(value);
  if (!item) return false;
  if (typeof item.$ref === "string" && !item.$ref.startsWith("#/")) return true;
  return Object.values(item).some((entry) => containsRemoteRef(entry, depth + 1));
}
