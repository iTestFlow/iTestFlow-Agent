import { z } from "zod";
import Ajv, { type ValidateFunction } from "ajv";

import {
  AGENT_ACTION_TYPES,
  AgentDecisionSchema,
  type AgentAction,
  type LayerHint,
} from "./action-schema";
import { validateAgentDecision } from "./agent-decision";
import { extractSecretReferences } from "./secret-resolution";

export const EXECUTION_LAYERS = ["ui", "api", "db"] as const;
export type ExecutionLayer = (typeof EXECUTION_LAYERS)[number];

const CaptureSchema = z.object({
  name: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/),
  pointer: z.string().trim().max(500).optional(),
  rowIndex: z.number().int().min(0).max(199).optional(),
  column: z.string().trim().max(200).optional(),
  sensitive: z.boolean().optional(),
});
export type LayerCapture = z.infer<typeof CaptureSchema>;

const JsonScalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const ParameterValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    JsonScalarSchema,
    z.array(ParameterValueSchema).max(200),
    z.record(z.string().max(100), ParameterValueSchema),
  ]),
);
const ParametersSchema = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), ParameterValueSchema).default({});

export const ApiRequestArgumentsSchema = z.object({
  method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]),
  path: z.string().trim().min(1).max(2_000).refine(isRelativeApiPath, "API path must be relative to the configured base URL."),
  query: z.record(z.string().max(200), JsonScalarSchema).default({}),
  headers: z.record(z.string().max(100), z.string().max(4_000)).default({}),
  /** JSON body for mutation methods; size is bounded by the executor's request cap. */
  body: ParameterValueSchema.optional(),
  /**
   * How the body is encoded. Many APIs document "Request Parameters" and read
   * form fields, not JSON — sending the wrong encoding makes the server report
   * the parameters as missing, so the agent has to be able to choose.
   */
  contentType: z
    .enum(["application/json", "application/x-www-form-urlencoded", "text/plain"])
    .optional(),
  captures: z.array(CaptureSchema).max(20).default([]),
});

export const OperationArgumentsSchema = z.object({
  operationId: z.string().trim().min(1).max(200),
  parameters: ParametersSchema,
  /** JSON request body for contract mutation operations that declare one. */
  body: ParameterValueSchema.optional(),
  captures: z.array(CaptureSchema).max(20).default([]),
});

export const DatabaseSchemaArgumentsSchema = z.object({
  tablePattern: z.string().trim().max(200).optional(),
});

export const DatabaseSelectArgumentsSchema = z.object({
  sql: z.string().trim().min(1).max(20_000),
  parameters: ParametersSchema,
  captures: z.array(CaptureSchema).max(20).default([]),
});

/** One parameterized INSERT/UPDATE/DELETE; the SQL policy enforces the rest. */
export const DatabaseMutateArgumentsSchema = DatabaseSelectArgumentsSchema;

export type IntegrationCapability = {
  id: string;
  name: string;
  layer: "api" | "db";
  safetyClass: "read" | "mutation";
  approved: boolean;
  driver?: "postgres" | "sqlserver" | "mysql";
  parameterSchema: Record<string, unknown>;
  /** JSON Schema for the operation's request body (v2 contract operations). */
  requestBodySchema?: Record<string, unknown>;
  requestBodyRequired?: boolean;
  definition: Record<string, unknown>;
};

const parameterSchemaValidator = new Ajv({
  allErrors: true,
  strict: false,
  coerceTypes: false,
  removeAdditional: false,
  useDefaults: false,
});
const compiledParameterSchemas = new WeakMap<Record<string, unknown>, ValidateFunction>();

export function validateCapabilityParameterSchema(schema: Record<string, unknown>): string | null {
  try {
    if (!compiledParameterSchemas.has(schema)) {
      compiledParameterSchemas.set(schema, parameterSchemaValidator.compile(schema));
    }
    return null;
  } catch {
    return "The operation parameter schema is not a valid JSON Schema.";
  }
}

/** Validate resolved operation inputs without logging parameter values. */
export function validateCapabilityParameters(
  capability: IntegrationCapability,
  parameters: Record<string, unknown>,
): string | null {
  let validate = compiledParameterSchemas.get(capability.parameterSchema);
  const schemaIssue = validateCapabilityParameterSchema(capability.parameterSchema);
  if (schemaIssue) {
    return `Operation "${capability.name}" has an invalid pinned parameter schema.`;
  }
  validate = compiledParameterSchemas.get(capability.parameterSchema);
  if (!validate) return `Operation "${capability.name}" has an invalid pinned parameter schema.`;
  if (validate(parameters)) return null;
  const details = (validate.errors ?? [])
    .slice(0, 5)
    .map((issue) => `${issue.instancePath || "/"} ${issue.message ?? issue.keyword}`)
    .join("; ");
  return `Operation "${capability.name}" parameters do not match the approved schema${details ? `: ${details}` : "."}`;
}

/** Validate a resolved JSON request body against the operation's pinned body schema. */
export function validateCapabilityRequestBody(
  capability: IntegrationCapability,
  body: unknown,
): string | null {
  if (body === undefined) return null;
  const schema = capability.requestBodySchema;
  if (!schema) return `Operation "${capability.name}" does not take a request body.`;
  if (validateCapabilityParameterSchema(schema)) {
    return `Operation "${capability.name}" has an invalid pinned body schema.`;
  }
  const validate = compiledParameterSchemas.get(schema);
  if (!validate) return `Operation "${capability.name}" has an invalid pinned body schema.`;
  if (validate(body)) return null;
  const details = (validate.errors ?? [])
    .slice(0, 5)
    .map((issue) => `${issue.instancePath || "/"} ${issue.message ?? issue.keyword}`)
    .join("; ");
  return `Operation "${capability.name}" request body does not match the contract schema${details ? `: ${details}` : "."}`;
}

export type MultiLayerAction =
  | { layer: "ui"; type: "ui_snapshot" }
  | { layer: "ui"; type: "ui_action"; action: AgentAction }
  | { layer: "api"; type: "api_request"; arguments: z.infer<typeof ApiRequestArgumentsSchema> }
  | {
      layer: "api";
      type: "api_execute_operation";
      capability: IntegrationCapability;
      arguments: z.infer<typeof OperationArgumentsSchema>;
    }
  | { layer: "db"; type: "db_schema"; arguments: z.infer<typeof DatabaseSchemaArgumentsSchema> }
  | { layer: "db"; type: "db_select"; arguments: z.infer<typeof DatabaseSelectArgumentsSchema> }
  | { layer: "db"; type: "db_mutate"; arguments: z.infer<typeof DatabaseMutateArgumentsSchema> }
  | {
      layer: "db";
      type: "db_execute_operation";
      capability: IntegrationCapability;
      arguments: z.infer<typeof OperationArgumentsSchema>;
    };

/**
 * Original authorization inputs of a run frozen BEFORE the intent-v1 policy
 * (no executionPolicyVersion in its env config). Present only for such legacy
 * runs — a queued pre-deploy run must never resume with broader authority
 * than it was approved with. intent-v1 runs pass undefined and have no
 * mutation gate: the layer being configured is the authorization.
 */
export type LegacyExecutionPolicy = {
  apiMutationsEnabled: boolean;
  databaseDmlEnabled: boolean;
};

export type MultiLayerDecisionContext = {
  layerHint: LayerHint;
  configuredLayers: ReadonlySet<ExecutionLayer>;
  snapshotRefs: ReadonlySet<string>;
  allowedOrigin?: string;
  /** Explicit "METHOD /path" requests from the frozen step text and notes. */
  allowedApiRequests: ReadonlySet<string>;
  secretNames: readonly string[];
  captureNames: readonly string[];
  capabilities: ReadonlyMap<string, IntegrationCapability>;
  legacyPolicy?: LegacyExecutionPolicy;
  databaseDriver?: "postgres" | "sqlserver" | "mysql";
};

export type ValidatedMultiLayerDecision =
  | { kind: "action"; action: MultiLayerAction }
  | { kind: "step_passed"; actualResult: string }
  | { kind: "step_failed"; actualResult: string }
  | { kind: "blocked"; reason: string }
  | { kind: "invalid"; feedback: string };

export function validateMultiLayerDecision(
  raw: unknown,
  context: MultiLayerDecisionContext,
): ValidatedMultiLayerDecision {
  const parsed = AgentDecisionSchema.safeParse(raw);
  if (!parsed.success) return invalid("Your response did not match the required JSON shape.");
  const decision = parsed.data;

  if (decision.decision === "step_passed" || decision.decision === "step_failed") {
    const actualResult = decision.actualResult?.trim();
    if (!actualResult) return invalid(`${decision.decision} requires actualResult with observed evidence.`);
    return { kind: decision.decision, actualResult: actualResult.slice(0, 2_000) };
  }
  if (decision.decision === "blocked") {
    return { kind: "blocked", reason: (decision.reason?.trim() || "The step cannot proceed.").slice(0, 1_000) };
  }

  const actionType = decision.actionType?.trim();
  if (!actionType) return invalid("act requires actionType.");

  if ((AGENT_ACTION_TYPES as readonly string[]).includes(actionType)) {
    const layerIssue = layerPolicyIssue("ui", context);
    if (layerIssue) return invalid(layerIssue);
    const ui = validateAgentDecision(raw, {
      snapshotRefs: context.snapshotRefs,
      allowedOrigin: context.allowedOrigin ?? "",
      secretNames: context.secretNames,
    });
    return ui.kind === "action"
      ? { kind: "action", action: { layer: "ui", type: "ui_action", action: ui.action } }
      : ui;
  }

  if (actionType === "ui_snapshot") {
    const issue = layerPolicyIssue("ui", context);
    return issue ? invalid(issue) : { kind: "action", action: { layer: "ui", type: "ui_snapshot" } };
  }

  const decoded = decodeArguments(decision.argumentsJson);
  if (!decoded.ok) return invalid(decoded.feedback);

  if (actionType === "api_request") {
    const issue = layerPolicyIssue("api", context);
    if (issue) return invalid(issue);
    const args = ApiRequestArgumentsSchema.safeParse(decoded.value);
    if (!args.success) return invalid(firstZodIssue(args.error));
    if ((args.data.method === "GET" || args.data.method === "HEAD") && args.data.body !== undefined) {
      return invalid("GET and HEAD requests do not take a body.");
    }
    // Approving a run authorizes the actions its steps require against the
    // configured target, so an endpoint the agent worked out from the step is
    // allowed: the wire still confines every request to the API origin and
    // base path, strips environment-owned headers, persists mutations before
    // dispatch, and never blindly retries an uncertain one. Legacy-intent runs
    // are the exception — they keep the read-only, explicitly-named surface
    // they were originally approved with.
    if (context.legacyPolicy
      && !matchesAllowedRequest(args.data.method, args.data.path, args.data.query, context.allowedApiRequests)) {
      return invalid("This run may only call API operations named in its frozen steps. Re-approve the run to use the current model.");
    }
    const forbidden = Object.keys(args.data.headers).find(isForbiddenAdHocHeader);
    if (forbidden) return invalid(`Header "${forbidden}" is environment-owned or unsafe.`);
    const referenceIssue = placeholderIssue(args.data, context);
    if (referenceIssue) return invalid(referenceIssue);
    return { kind: "action", action: { layer: "api", type: "api_request", arguments: args.data } };
  }

  if (actionType === "api_execute_operation" || actionType === "db_execute_operation") {
    const layer = actionType.startsWith("api_") ? "api" : "db";
    const issue = layerPolicyIssue(layer, context);
    if (issue) return invalid(issue);
    const args = OperationArgumentsSchema.safeParse(decoded.value);
    if (!args.success) return invalid(firstZodIssue(args.error));
    const capability = context.capabilities.get(args.data.operationId);
    if (!capability || capability.layer !== layer || !capability.approved) {
      return invalid(`Operation "${args.data.operationId}" is not an approved ${layer.toUpperCase()} capability.`);
    }
    // The mutation gate exists only for legacy-intent frozen runs; intent-v1
    // runs authorize mutations by configuring the layer (see LegacyExecutionPolicy).
    if (capability.safetyClass === "mutation" && context.legacyPolicy) {
      if (layer === "api" && !context.legacyPolicy.apiMutationsEnabled) return invalid("API mutations are disabled for this environment.");
      if (layer === "db" && !context.legacyPolicy.databaseDmlEnabled) return invalid("Database DML is disabled for this environment.");
    }
    if (layer === "db" && capability.driver && capability.driver !== context.databaseDriver) {
      return invalid(`Operation "${capability.name}" is not compatible with the configured database driver.`);
    }
    if (args.data.body !== undefined && (layer === "db" || !capability.requestBodySchema)) {
      return invalid(`Operation "${capability.name}" does not take a request body.`);
    }
    if (layer === "api" && capability.requestBodyRequired && args.data.body === undefined) {
      return invalid(`Operation "${capability.name}" requires a JSON request body.`);
    }
    const referenceIssue = placeholderIssue(args.data, context);
    if (referenceIssue) return invalid(referenceIssue);
    return layer === "api"
      ? { kind: "action", action: { layer, type: "api_execute_operation", capability, arguments: args.data } }
      : { kind: "action", action: { layer, type: "db_execute_operation", capability, arguments: args.data } };
  }

  if (actionType === "db_schema") {
    const issue = layerPolicyIssue("db", context);
    if (issue) return invalid(issue);
    const args = DatabaseSchemaArgumentsSchema.safeParse(decoded.value);
    return args.success
      ? { kind: "action", action: { layer: "db", type: "db_schema", arguments: args.data } }
      : invalid(firstZodIssue(args.error));
  }

  if (actionType === "db_select") {
    const issue = layerPolicyIssue("db", context);
    if (issue) return invalid(issue);
    const args = DatabaseSelectArgumentsSchema.safeParse(decoded.value);
    if (!args.success) return invalid(firstZodIssue(args.error));
    const referenceIssue = placeholderIssue(args.data, context);
    if (referenceIssue) return invalid(referenceIssue);
    return { kind: "action", action: { layer: "db", type: "db_select", arguments: args.data } };
  }

  if (actionType === "db_mutate") {
    const issue = layerPolicyIssue("db", context);
    if (issue) return invalid(issue);
    // Legacy-intent runs never had an ad-hoc DML path; they keep the approved
    // catalog operations they were frozen with.
    if (context.legacyPolicy) {
      return invalid("Composing database changes is not enabled for this run; use an approved database operation.");
    }
    const args = DatabaseMutateArgumentsSchema.safeParse(decoded.value);
    if (!args.success) return invalid(firstZodIssue(args.error));
    const referenceIssue = placeholderIssue(args.data, context);
    if (referenceIssue) return invalid(referenceIssue);
    return { kind: "action", action: { layer: "db", type: "db_mutate", arguments: args.data } };
  }

  return invalid(`Unsupported actionType "${actionType}".`);
}

export function describeMultiLayerAction(action: MultiLayerAction): string {
  switch (action.type) {
    case "ui_snapshot": return "Inspect the current UI";
    case "ui_action": return `${action.action.type} UI action`;
    case "api_request": return `${action.arguments.method} ${action.arguments.path}`;
    case "api_execute_operation": return `API operation ${action.capability.name}`;
    case "db_schema": return action.arguments.tablePattern
      ? `Inspect database schema for ${action.arguments.tablePattern}`
      : "Inspect database schema";
    case "db_select": return "Execute parameterized database SELECT";
    case "db_mutate": return "Execute parameterized database mutation";
    case "db_execute_operation": return `Database operation ${action.capability.name}`;
  }
}

function layerPolicyIssue(layer: ExecutionLayer, context: MultiLayerDecisionContext): string | null {
  if (!context.configuredLayers.has(layer)) return `${layer.toUpperCase()} is not configured for this environment.`;
  if (context.layerHint === "ui" && layer !== "ui") return "This step is restricted to the UI layer.";
  if (context.layerHint === "api" && layer !== "api") return "This step is restricted to the API layer.";
  if (context.layerHint === "db" && layer !== "db") return "This step is restricted to the database layer.";
  return null;
}

function decodeArguments(value?: string): { ok: true; value: unknown } | { ok: false; feedback: string } {
  if (!value) return { ok: true, value: {} };
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, feedback: "argumentsJson must encode one JSON object." };
    }
    return { ok: true, value: parsed };
  } catch {
    return { ok: false, feedback: "argumentsJson must encode one valid JSON object." };
  }
}

function placeholderIssue(value: unknown, context: MultiLayerDecisionContext): string | null {
  for (const text of stringsIn(value)) {
    const unknownSecret = extractSecretReferences(text).find((name) => !context.secretNames.includes(name));
    if (unknownSecret) return `{{secret:${unknownSecret}}} is not an available agent value.`;
    const captures = [...text.matchAll(/\{\{capture:([A-Za-z][A-Za-z0-9_.-]{0,63})\}\}/g)].map((match) => match[1]);
    const unknownCapture = captures.find((name) => !context.captureNames.includes(name));
    if (unknownCapture) return `{{capture:${unknownCapture}}} has not been captured in this case.`;
  }
  return null;
}

function* stringsIn(value: unknown): Generator<string> {
  if (typeof value === "string") {
    yield value;
  } else if (Array.isArray(value)) {
    for (const item of value) yield* stringsIn(item);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) yield* stringsIn(item);
  }
}

function isRelativeApiPath(value: string) {
  if (value.startsWith("//")) return false;
  try {
    const url = new URL(value, "https://configured.invalid/");
    return url.origin === "https://configured.invalid";
  } catch {
    return false;
  }
}

function matchesAllowedRequest(
  method: string,
  path: string,
  query: Record<string, string | number | boolean | null>,
  allowed: ReadonlySet<string>,
) {
  const target = `${method.toUpperCase()} ${normalizePath(path, query)}`;
  return [...allowed].some((candidate) => {
    const separator = candidate.indexOf(" ");
    if (separator < 0) return false;
    const candidateMethod = candidate.slice(0, separator).toUpperCase();
    const candidatePath = candidate.slice(separator + 1);
    return `${candidateMethod} ${normalizePath(candidatePath, {})}` === target;
  });
}

function normalizePath(path: string, query: Record<string, string | number | boolean | null>) {
  try {
    const url = new URL(path, "https://configured.invalid/");
    for (const [name, value] of Object.entries(query)) {
      if (value !== null) url.searchParams.set(name, String(value));
    }
    url.searchParams.sort();
    return `${url.pathname}${url.search}`;
  } catch {
    return path;
  }
}

function isForbiddenAdHocHeader(name: string) {
  const normalized = name.trim().toLowerCase();
  const safeHeaders = new Set([
    "accept",
    "accept-language",
    "if-match",
    "if-none-match",
    "if-modified-since",
    "if-unmodified-since",
    "range",
  ]);
  return !safeHeaders.has(normalized);
}

function firstZodIssue(error: z.ZodError) {
  const issue = error.issues[0];
  return issue ? `${issue.path.join(".") || "arguments"}: ${issue.message}` : "Invalid action arguments.";
}

function invalid(feedback: string): ValidatedMultiLayerDecision {
  return { kind: "invalid", feedback };
}
