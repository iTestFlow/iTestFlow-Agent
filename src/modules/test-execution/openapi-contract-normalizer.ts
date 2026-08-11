import type { IntegrationCapability } from "./multi-layer-action";

export const MAX_OPENAPI_OPERATIONS = 500;

export type NormalizedOpenApiScalarSchema = {
  type: "string" | "integer" | "number" | "boolean";
  enum?: Array<string | number | boolean>;
};

export type NormalizedOpenApiOperation = {
  stableKey: string;
  operationId: string;
  displayName: string;
  method: "GET" | "HEAD";
  path: string;
  pathParameters: string[];
  queryParameters: Array<{ name: string; required: boolean }>;
  parameterSchema: {
    type: "object";
    properties: Record<string, NormalizedOpenApiScalarSchema>;
    required: string[];
    additionalProperties: false;
  };
};

export type NormalizedOpenApiContract = {
  schemaVersion: "itestflow.openapi.v1";
  openapiVersion: string;
  operations: NormalizedOpenApiOperation[];
};

export class OpenApiNormalizationError extends Error {
  constructor(readonly clientMessage: string) {
    super(clientMessage);
    this.name = "OpenApiNormalizationError";
  }
}

/**
 * Reduce an untrusted OpenAPI document to the read-only operation manifest the
 * executor needs. Servers, authentication, headers, request bodies, examples,
 * descriptions, and the original document are deliberately not retained.
 */
export function normalizeOpenApiDocument(document: unknown): NormalizedOpenApiContract {
  const root = asRecord(document);
  const version = typeof root?.openapi === "string" ? root.openapi.trim() : "";
  if (!/^3\.(?:0|1)(?:\.\d+)?$/.test(version)) {
    throw new OpenApiNormalizationError("The document must be an OpenAPI 3.0 or 3.1 JSON document.");
  }
  const paths = asRecord(root?.paths);
  if (!paths) throw new OpenApiNormalizationError("The OpenAPI document does not contain a paths object.");

  const operations: NormalizedOpenApiOperation[] = [];
  const usedOperationIds = new Set<string>();
  const usedStableKeys = new Set<string>();
  for (const path of Object.keys(paths).sort()) {
    if (!isSafePathTemplate(path)) continue;
    const pathItem = asRecord(paths[path]);
    if (!pathItem) continue;
    const pathParameters = extractPathParameters(path);
    if (!pathParameters || pathParameters.length > 50 || pathParameters.some(looksCredentialLike)) continue;

    for (const method of ["get", "head"] as const) {
      const operation = asRecord(pathItem[method]);
      if (!operation || operation.deprecated === true) continue;
      if (operations.length >= MAX_OPENAPI_OPERATIONS) {
        throw new OpenApiNormalizationError(
          `The OpenAPI document exceeds the ${MAX_OPENAPI_OPERATIONS}-operation read-only limit.`,
        );
      }
      const declaredParameters = collectOperationParameters(
        pathParameters,
        pathItem.parameters,
        operation.parameters,
      );
      if (!declaredParameters) continue;
      const properties = Object.fromEntries([
        ...pathParameters.map((name) => [name, declaredParameters.pathSchemas.get(name)!] as const),
        ...declaredParameters.queryParameters.map((parameter) => [parameter.name, parameter.schema] as const),
      ]);
      const upperMethod = method.toUpperCase() as "GET" | "HEAD";
      const preferredId = safeOperationId(operation.operationId);
      const operationId = uniqueOperationId(
        preferredId ?? generatedOperationId(method, path),
        usedOperationIds,
      );
      const stableKey = operationStableKey(method, path);
      if (usedStableKeys.has(stableKey)) {
        throw new OpenApiNormalizationError("The OpenAPI document contains colliding operation identities.");
      }
      usedStableKeys.add(stableKey);
      operations.push({
        stableKey,
        operationId,
        displayName: preferredId ?? `${upperMethod} ${path}`.slice(0, 200),
        method: upperMethod,
        path,
        pathParameters,
        queryParameters: declaredParameters.queryParameters.map(({ name, required }) => ({ name, required })),
        parameterSchema: {
          type: "object",
          properties,
          required: [
            ...pathParameters,
            ...declaredParameters.queryParameters
              .filter((parameter) => parameter.required)
              .map((parameter) => parameter.name),
          ],
          additionalProperties: false,
        },
      });
    }
  }

  if (operations.length === 0) {
    throw new OpenApiNormalizationError("The OpenAPI document has no safe GET or HEAD operations.");
  }
  return {
    schemaVersion: "itestflow.openapi.v1",
    openapiVersion: version,
    operations,
  };
}

/**
 * Convert a frozen normalized manifest into the exact runtime capability
 * shape. Capability IDs combine the immutable revision ID with the stable
 * method/path key, so an agent can never accidentally target another revision.
 */
export function buildOpenApiIntegrationCapabilities(
  revisionId: string,
  normalizedSpec: unknown,
): IntegrationCapability[] {
  const normalized = asRecord(normalizedSpec);
  if (
    !revisionId ||
    revisionId.length > 120 ||
    normalized?.schemaVersion !== "itestflow.openapi.v1" ||
    !Array.isArray(normalized.operations) ||
    normalized.operations.length === 0 ||
    normalized.operations.length > MAX_OPENAPI_OPERATIONS
  ) {
    throw new OpenApiNormalizationError("The frozen OpenAPI operation manifest is invalid.");
  }
  return normalized.operations.map((value) => {
    const operation = asRecord(value);
    const stableKey = typeof operation?.stableKey === "string" ? operation.stableKey : "";
    const operationId = typeof operation?.operationId === "string" ? operation.operationId : "";
    const displayName = typeof operation?.displayName === "string" ? operation.displayName : "";
    const method = operation?.method;
    const path = typeof operation?.path === "string" ? operation.path : "";
    const pathParameters = stringArray(operation?.pathParameters);
    const rawQueryParameters = Array.isArray(operation?.queryParameters)
      ? operation.queryParameters
      : null;
    const queryParameters = rawQueryParameters?.map((value) => {
      const parameter = asRecord(value);
      return {
        name: typeof parameter?.name === "string" ? parameter.name : "",
        required: parameter?.required,
      };
    }) ?? null;
    const parameterSchema = asRecord(operation?.parameterSchema);
    if (
      !/^openapi\.(?:get|head)\.[0-9a-f]{16}$/.test(stableKey) ||
      !safeOperationId(operationId) ||
      !displayName ||
      (method !== "GET" && method !== "HEAD") ||
      !isSafePathTemplate(path) ||
      !parameterSchema ||
      !pathParameters ||
      !queryParameters ||
      pathParameters.some((name) => !isSafeParameterName(name) || looksCredentialLike(name))
      || queryParameters.some((parameter) =>
        !isSafeParameterName(parameter.name) ||
        looksCredentialLike(parameter.name) ||
        typeof parameter.required !== "boolean" ||
        pathParameters.includes(parameter.name)
      )
    ) {
      throw new OpenApiNormalizationError("The frozen OpenAPI operation manifest is invalid.");
    }
    return {
      id: `${revisionId}:${stableKey}`,
      name: displayName,
      layer: "api" as const,
      safetyClass: "read" as const,
      approved: true,
      parameterSchema,
      definition: {
        operationId,
        method,
        path,
        pathParameters,
        query: Object.fromEntries(
          queryParameters.map((parameter) => [parameter.name, `{{param:${parameter.name}}}`]),
        ),
      },
    };
  });
}

function collectOperationParameters(
  pathNames: string[],
  pathParameters: unknown,
  operationParameters: unknown,
): {
  pathSchemas: Map<string, NormalizedOpenApiScalarSchema>;
  queryParameters: Array<{
    name: string;
    required: boolean;
    schema: NormalizedOpenApiScalarSchema;
  }>;
} | null {
  const declarations = new Map<string, Record<string, unknown>>();
  for (const candidate of [
    ...(Array.isArray(pathParameters) ? pathParameters : []),
    ...(Array.isArray(operationParameters) ? operationParameters : []),
  ]) {
    const parameter = asRecord(candidate);
    const name = typeof parameter?.name === "string" ? parameter.name.trim() : "";
    if (!parameter || (parameter.in !== "path" && parameter.in !== "query")) continue;
    declarations.set(`${parameter.in}:${name}`, parameter);
  }

  const pathSchemas = new Map<string, NormalizedOpenApiScalarSchema>();
  for (const name of pathNames) {
    const declaration = declarations.get(`path:${name}`);
    const schema = declaration ? normalizeScalarSchema(declaration.schema) : { type: "string" as const };
    if (!schema) return null;
    pathSchemas.set(name, schema);
  }

  const queryParameters: Array<{
    name: string;
    required: boolean;
    schema: NormalizedOpenApiScalarSchema;
  }> = [];
  for (const [key, declaration] of declarations) {
    if (!key.startsWith("query:")) continue;
    const name = key.slice("query:".length);
    const required = declaration.required === true;
    if (!isSafeParameterName(name) || looksCredentialLike(name) || pathNames.includes(name)) {
      if (required) return null;
      continue;
    }
    const schema = normalizeScalarSchema(declaration.schema);
    if (!schema) {
      if (required) return null;
      continue;
    }
    queryParameters.push({ name, required, schema });
  }
  queryParameters.sort((left, right) => left.name.localeCompare(right.name));
  if (pathNames.length + queryParameters.length > 50) return null;
  return { pathSchemas, queryParameters };
}

function normalizeScalarSchema(value: unknown): NormalizedOpenApiScalarSchema | null {
  const schema = asRecord(value);
  const type = schema?.type;
  if (type !== "string" && type !== "integer" && type !== "number" && type !== "boolean") return null;
  const normalizedType = type;
  const normalized: NormalizedOpenApiScalarSchema = { type: normalizedType };
  if (Array.isArray(schema?.enum) && schema.enum.length > 0 && schema.enum.length <= 50) {
    const values = schema.enum.filter((entry): entry is string | number | boolean =>
      (typeof entry === "string" && entry.length <= 200) ||
      (typeof entry === "number" && Number.isFinite(entry)) ||
      typeof entry === "boolean",
    );
    if (values.length === schema.enum.length && values.every((entry) => typeof entry === normalizedType || (
      normalizedType === "integer" && typeof entry === "number" && Number.isInteger(entry)
    ))) {
      normalized.enum = values;
    }
  }
  return normalized;
}

function extractPathParameters(path: string): string[] | null {
  const names: string[] = [];
  for (const match of path.matchAll(/\{([^{}]+)\}/g)) {
    const name = match[1];
    if (!isSafeParameterName(name)) return null;
    if (!names.includes(name)) names.push(name);
  }
  const withoutParameters = path.replace(/\{[^{}]+\}/g, "");
  return withoutParameters.includes("{") || withoutParameters.includes("}") ? null : names;
}

function isSafePathTemplate(path: string): boolean {
  if (
    path.length < 1 ||
    path.length > 2_000 ||
    !path.startsWith("/") ||
    path.startsWith("//") ||
    /[\s\\?#]/.test(path) ||
    path.includes("://")
  ) return false;
  try {
    const decoded = decodeURIComponent(path);
    return !decoded.split("/").some((segment) => segment === "." || segment === "..");
  } catch {
    return false;
  }
}

function isSafeParameterName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name) &&
    name !== "__proto__" && name !== "constructor" && name !== "prototype";
}

function looksCredentialLike(name: string): boolean {
  return /(password|passwd|secret|token|authorization|credential|cookie|session|api[_-]?key|private[_-]?key)/i.test(name);
}

function safeOperationId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return /^[A-Za-z][A-Za-z0-9_.-]{0,119}$/.test(id) ? id : null;
}

function generatedOperationId(method: "get" | "head", path: string): string {
  const slug = path
    .replace(/\{([^{}]+)\}/g, "by_$1")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 90);
  return `${method}_${slug || "root"}_${shortHash(`${method}:${path}`)}`;
}

function uniqueOperationId(base: string, used: Set<string>): string {
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base.slice(0, 115)}_${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function operationStableKey(method: "get" | "head", path: string): string {
  return `openapi.${method}.${shortHash(`${method}:${path}`)}`;
}

function shortHash(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : null;
}
