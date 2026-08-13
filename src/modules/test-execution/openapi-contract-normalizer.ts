import { isForbiddenRequestHeader } from "@/modules/shared/sensitive-data";

import type { IntegrationCapability } from "./multi-layer-action";
import {
  createRefResolutionBudget,
  resolveBoundedSchema,
  resolveLocalComponentRef,
} from "./openapi-ref-resolver";

export const MAX_OPENAPI_OPERATIONS = 500;

export const OPENAPI_MANIFEST_VERSION_V1 = "itestflow.openapi.v1" as const;
export const OPENAPI_MANIFEST_VERSION_V2 = "itestflow.openapi.v2" as const;

const V2_METHODS = ["get", "head", "post", "put", "patch", "delete"] as const;
type V2Method = (typeof V2_METHODS)[number];
type UpperMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";

export type NormalizedOpenApiScalarSchema = {
  type: "string" | "integer" | "number" | "boolean";
  enum?: Array<string | number | boolean>;
};

export type NormalizedOpenApiOperation = {
  stableKey: string;
  operationId: string;
  displayName: string;
  method: UpperMethod;
  /** GET/HEAD are reads; every other method is a mutation. The only rule. */
  safetyClass: "read" | "mutation";
  path: string;
  pathParameters: string[];
  queryParameters: Array<{ name: string; required: boolean }>;
  /**
   * Non-sensitive header parameters. `property` is the sanitized
   * parameterSchema property backing the header value.
   */
  headerParameters: Array<{ name: string; property: string; required: boolean }>;
  parameterSchema: {
    type: "object";
    properties: Record<string, NormalizedOpenApiScalarSchema>;
    required: string[];
    additionalProperties: false;
  };
  /**
   * JSON request body on its own channel — never a parameterSchema property,
   * so a path/query parameter literally named "body" can never collide.
   */
  requestBody: {
    contentType: "application/json";
    required: boolean;
    schema: Record<string, unknown>;
  } | null;
};

export type NormalizedOpenApiContract = {
  schemaVersion: typeof OPENAPI_MANIFEST_VERSION_V2;
  openapiVersion: string;
  operations: NormalizedOpenApiOperation[];
  /** Operations skipped because they could not be imported safely. */
  droppedOperationCount: number;
};

export class OpenApiNormalizationError extends Error {
  constructor(readonly clientMessage: string) {
    super(clientMessage);
    this.name = "OpenApiNormalizationError";
  }
}

/**
 * Reduce an untrusted OpenAPI document to the operation manifest the executor
 * needs — reads and writes. Servers, authentication/sensitive headers,
 * examples, descriptions, and the original document are deliberately not
 * retained. Request-body schemas are inlined through the bounded local-$ref
 * resolver; an operation whose REQUIRED body/header/cookie cannot be imported
 * safely is dropped (counted in droppedOperationCount), never guessed at.
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
  let dropped = 0;
  const usedOperationIds = new Set<string>();
  const usedStableKeys = new Set<string>();
  for (const path of Object.keys(paths).sort()) {
    if (!isSafePathTemplate(path)) continue;
    const pathItem = asRecord(paths[path]);
    if (!pathItem) continue;
    const pathParameters = extractPathParameters(path);
    if (!pathParameters || pathParameters.length > 50 || pathParameters.some(looksCredentialLike)) continue;

    for (const method of V2_METHODS) {
      const operation = asRecord(pathItem[method]);
      if (!operation || operation.deprecated === true) continue;
      if (operations.length >= MAX_OPENAPI_OPERATIONS) {
        throw new OpenApiNormalizationError(
          `The OpenAPI document exceeds the ${MAX_OPENAPI_OPERATIONS}-operation limit.`,
        );
      }
      // One shared resolution budget per operation bounds every $ref walk.
      const budget = createRefResolutionBudget();
      const declaredParameters = collectOperationParameters(
        pathParameters,
        pathItem.parameters,
        operation.parameters,
        root,
        budget,
      );
      if (!declaredParameters) {
        dropped += 1;
        continue;
      }
      const upperMethod = method.toUpperCase() as UpperMethod;
      const safetyClass = methodSafetyClass(upperMethod);
      const requestBody = normalizeRequestBody(operation.requestBody, root, budget);
      if (requestBody === "drop") {
        dropped += 1;
        continue;
      }
      const properties = Object.fromEntries([
        ...pathParameters.map((name) => [name, declaredParameters.pathSchemas.get(name)!] as const),
        ...declaredParameters.queryParameters.map((parameter) => [parameter.name, parameter.schema] as const),
        ...declaredParameters.headerParameters.map((parameter) => [parameter.property, { type: "string" as const }] as const),
      ]);
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
        safetyClass,
        path,
        pathParameters,
        queryParameters: declaredParameters.queryParameters.map(({ name, required }) => ({ name, required })),
        headerParameters: declaredParameters.headerParameters,
        parameterSchema: {
          type: "object",
          properties,
          required: [
            ...pathParameters,
            ...declaredParameters.queryParameters
              .filter((parameter) => parameter.required)
              .map((parameter) => parameter.name),
            ...declaredParameters.headerParameters
              .filter((parameter) => parameter.required)
              .map((parameter) => parameter.property),
          ],
          additionalProperties: false,
        },
        requestBody,
      });
    }
  }

  if (operations.length === 0) {
    throw new OpenApiNormalizationError("The OpenAPI document has no importable operations.");
  }
  return {
    schemaVersion: OPENAPI_MANIFEST_VERSION_V2,
    openapiVersion: version,
    operations,
    droppedOperationCount: dropped,
  };
}

function methodSafetyClass(method: UpperMethod): "read" | "mutation" {
  return method === "GET" || method === "HEAD" ? "read" : "mutation";
}

/**
 * Returns the normalized body, null (no JSON body imported), or "drop" when a
 * REQUIRED body cannot be imported safely.
 */
function normalizeRequestBody(
  value: unknown,
  root: Record<string, unknown> | null,
  budget: ReturnType<typeof createRefResolutionBudget>,
):
  | NormalizedOpenApiOperation["requestBody"]
  | "drop" {
  if (value === undefined || value === null) return null;
  const bodyObject = resolveLocalComponentRef(value, root, ["requestBodies"]);
  if (!bodyObject) return "drop";
  const required = bodyObject.required === true;
  const content = asRecord(bodyObject.content);
  if (!content) return required ? "drop" : null;
  const jsonKey = Object.keys(content).find((key) => {
    const media = key.split(";")[0]?.trim().toLowerCase() ?? "";
    return media === "application/json" || media.endsWith("+json");
  });
  if (!jsonKey) return required ? "drop" : null;
  const media = asRecord(content[jsonKey]);
  const schema = media?.schema === undefined
    ? {}
    : resolveBoundedSchema(media.schema, root, budget);
  if (schema === null) return required ? "drop" : null;
  return { contentType: "application/json", required, schema };
}

/**
 * Convert a frozen normalized manifest into the exact runtime capability
 * shape. Capability IDs combine the immutable revision ID with the stable
 * method/path key, so an agent can never accidentally target another revision.
 * Both manifest versions stay readable: v1 (read-only GET/HEAD) manifests are
 * pinned by historical runs and must keep projecting byte-for-byte.
 */
export function buildOpenApiIntegrationCapabilities(
  revisionId: string,
  normalizedSpec: unknown,
): IntegrationCapability[] {
  const normalized = asRecord(normalizedSpec);
  if (
    !revisionId ||
    revisionId.length > 120 ||
    (normalized?.schemaVersion !== OPENAPI_MANIFEST_VERSION_V1 &&
      normalized?.schemaVersion !== OPENAPI_MANIFEST_VERSION_V2) ||
    !Array.isArray(normalized.operations) ||
    normalized.operations.length === 0 ||
    normalized.operations.length > MAX_OPENAPI_OPERATIONS
  ) {
    throw new OpenApiNormalizationError("The frozen OpenAPI operation manifest is invalid.");
  }
  const isV2 = normalized.schemaVersion === OPENAPI_MANIFEST_VERSION_V2;
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
    const stableKeyPattern = isV2
      ? /^openapi\.(?:get|head|post|put|patch|delete)\.[0-9a-f]{16}$/
      : /^openapi\.(?:get|head)\.[0-9a-f]{16}$/;
    const methodIsValid = isV2
      ? typeof method === "string" && ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(method)
      : method === "GET" || method === "HEAD";
    if (
      !stableKeyPattern.test(stableKey) ||
      !safeOperationId(operationId) ||
      !displayName ||
      !methodIsValid ||
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

    if (!isV2) {
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
    }

    // v2: the safety class must be present AND agree with the method — a
    // tampered manifest can never downgrade a mutation to a read.
    const safetyClass = operation?.safetyClass;
    const expectedClass = methodSafetyClass(method as UpperMethod);
    const headerParameters = normalizedHeaderParameters(operation?.headerParameters, pathParameters, queryParameters.map((parameter) => parameter.name));
    const requestBody = normalizedFrozenRequestBody(operation?.requestBody);
    if (safetyClass !== expectedClass || headerParameters === null || requestBody === "invalid") {
      throw new OpenApiNormalizationError("The frozen OpenAPI operation manifest is invalid.");
    }
    return {
      id: `${revisionId}:${stableKey}`,
      name: displayName,
      layer: "api" as const,
      safetyClass: expectedClass,
      approved: true,
      parameterSchema,
      ...(requestBody ? { requestBodySchema: requestBody.schema, requestBodyRequired: requestBody.required } : {}),
      definition: {
        operationId,
        method,
        path,
        pathParameters,
        query: Object.fromEntries(
          queryParameters.map((parameter) => [parameter.name, `{{param:${parameter.name}}}`]),
        ),
        ...(headerParameters.length
          ? {
              headers: Object.fromEntries(
                headerParameters.map((parameter) => [parameter.name, `{{param:${parameter.property}}}`]),
              ),
            }
          : {}),
        ...(requestBody ? { contentType: requestBody.contentType } : {}),
      },
    };
  });
}

function normalizedHeaderParameters(
  value: unknown,
  pathParameters: readonly string[],
  queryNames: readonly string[],
): Array<{ name: string; property: string; required: boolean }> | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const results: Array<{ name: string; property: string; required: boolean }> = [];
  for (const entry of value) {
    const record = asRecord(entry);
    const name = typeof record?.name === "string" ? record.name : "";
    const property = typeof record?.property === "string" ? record.property : "";
    if (
      !isSafeHeaderName(name) ||
      isForbiddenRequestHeader(name) ||
      looksCredentialLike(name) ||
      !isSafeParameterName(property) ||
      looksCredentialLike(property) ||
      pathParameters.includes(property) ||
      queryNames.includes(property) ||
      typeof record?.required !== "boolean"
    ) {
      return null;
    }
    results.push({ name, property, required: record.required });
  }
  return results;
}

function normalizedFrozenRequestBody(
  value: unknown,
): { contentType: "application/json"; required: boolean; schema: Record<string, unknown> } | null | "invalid" {
  if (value === undefined || value === null) return null;
  const record = asRecord(value);
  const schema = asRecord(record?.schema);
  if (!record || record.contentType !== "application/json" || typeof record.required !== "boolean" || !schema) {
    return "invalid";
  }
  return { contentType: "application/json", required: record.required, schema };
}

function collectOperationParameters(
  pathNames: string[],
  pathParameters: unknown,
  operationParameters: unknown,
  root: Record<string, unknown> | null,
  budget: ReturnType<typeof createRefResolutionBudget>,
): {
  pathSchemas: Map<string, NormalizedOpenApiScalarSchema>;
  queryParameters: Array<{
    name: string;
    required: boolean;
    schema: NormalizedOpenApiScalarSchema;
  }>;
  headerParameters: Array<{ name: string; property: string; required: boolean }>;
} | null {
  const declarations = new Map<string, Record<string, unknown>>();
  for (const candidate of [
    ...(Array.isArray(pathParameters) ? pathParameters : []),
    ...(Array.isArray(operationParameters) ? operationParameters : []),
  ]) {
    // A parameter object may itself be a local $ref into #/components/parameters.
    const parameter = resolveLocalComponentRef(candidate, root, ["parameters"]);
    const name = typeof parameter?.name === "string" ? parameter.name.trim() : "";
    if (!parameter || !name) continue;
    if (parameter.in === "cookie") {
      // Cookies are environment-owned; a required cookie makes the operation unusable.
      if (parameter.required === true) return null;
      continue;
    }
    if (parameter.in !== "path" && parameter.in !== "query" && parameter.in !== "header") continue;
    declarations.set(`${parameter.in}:${name}`, parameter);
  }

  const pathSchemas = new Map<string, NormalizedOpenApiScalarSchema>();
  for (const name of pathNames) {
    const declaration = declarations.get(`path:${name}`);
    const schema = declaration
      ? normalizeScalarSchema(declaration.schema, root, budget)
      : { type: "string" as const };
    if (!schema) return null;
    pathSchemas.set(name, schema);
  }

  const queryParameters: Array<{
    name: string;
    required: boolean;
    schema: NormalizedOpenApiScalarSchema;
  }> = [];
  const headerParameters: Array<{ name: string; property: string; required: boolean }> = [];
  const usedProperties = new Set<string>(pathNames);
  for (const [key, declaration] of declarations) {
    if (key.startsWith("query:")) {
      const name = key.slice("query:".length);
      const required = declaration.required === true;
      if (!isSafeParameterName(name) || looksCredentialLike(name) || pathNames.includes(name)) {
        if (required) return null;
        continue;
      }
      const schema = normalizeScalarSchema(declaration.schema, root, budget);
      if (!schema) {
        if (required) return null;
        continue;
      }
      queryParameters.push({ name, required, schema });
      usedProperties.add(name);
    }
  }
  for (const [key, declaration] of declarations) {
    if (!key.startsWith("header:")) continue;
    const name = key.slice("header:".length);
    const required = declaration.required === true;
    if (!isSafeHeaderName(name) || isForbiddenRequestHeader(name) || looksCredentialLike(name)) {
      // Auth/sensitive headers are environment-owned: a required one makes the
      // operation unimportable; optional ones are simply excluded.
      if (required) return null;
      continue;
    }
    const property = uniqueHeaderProperty(name, usedProperties);
    if (!property) {
      if (required) return null;
      continue;
    }
    usedProperties.add(property);
    headerParameters.push({ name, property, required });
  }
  queryParameters.sort((left, right) => left.name.localeCompare(right.name));
  headerParameters.sort((left, right) => left.name.localeCompare(right.name));
  if (pathNames.length + queryParameters.length + headerParameters.length > 50) return null;
  return { pathSchemas, queryParameters, headerParameters };
}

function isSafeHeaderName(name: string): boolean {
  return /^[A-Za-z][A-Za-z0-9-]{0,99}$/.test(name);
}

function uniqueHeaderProperty(headerName: string, used: ReadonlySet<string>): string | null {
  const base = `header_${headerName.toLowerCase().replace(/-/g, "_")}`;
  if (!isSafeParameterName(base)) return null;
  if (!used.has(base)) return base;
  for (let suffix = 2; suffix <= 9; suffix += 1) {
    const candidate = `${base}_${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  return null;
}

function normalizeScalarSchema(
  value: unknown,
  root: Record<string, unknown> | null,
  budget: ReturnType<typeof createRefResolutionBudget>,
): NormalizedOpenApiScalarSchema | null {
  // Parameter schemas may be local $refs; resolve within the shared budget
  // first, then require a scalar as before.
  const resolved = asRecord(value)?.$ref !== undefined
    ? resolveBoundedSchema(value, root, budget)
    : asRecord(value);
  const schema = asRecord(resolved);
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

function generatedOperationId(method: V2Method, path: string): string {
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

function operationStableKey(method: V2Method, path: string): string {
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
