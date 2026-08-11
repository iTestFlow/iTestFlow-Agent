import { z } from "zod";

import { NaturalPlanSchema } from "../action-schema";
import { SECRET_NAME_PATTERN } from "../secret-resolution";

/**
 * Request/response schemas for the Test Execution API routes. Secret VALUES
 * appear only in write requests (create/update); every read model exposes
 * masked previews exclusively. Plans are natural-language steps — the agent
 * chooses concrete browser actions at run time.
 */

export const SecretPurposeSchema = z.enum(["agent_value", "api_auth", "db_connection"]);
export type SecretPurpose = z.infer<typeof SecretPurposeSchema>;

export const API_CONNECTION_SECRET_NAMES = [
  "api.bearer_token",
  "api.api_key",
  "api.basic_password",
  "api.oauth_client_secret",
] as const;
export const DATABASE_PASSWORD_SECRET_NAME = "db.password" as const;

const ApiConnectionSecretNameSchema = z.enum(API_CONNECTION_SECRET_NAMES);

export const SecretInputSchema = z
  .object({
    secretName: z.string().trim().min(1).max(64),
    title: z.string().trim().min(1).max(120),
    value: z.string().min(1).max(4_096),
    /**
     * Connection secrets are routed directly to deterministic executors and
     * are never exposed as agent-substitutable {{secret:NAME}} values.
     */
    purpose: SecretPurposeSchema.default("agent_value"),
  })
  .superRefine((secret, ctx) => {
    const valid =
      (secret.purpose === "agent_value" && SECRET_NAME_PATTERN.test(secret.secretName)) ||
      (secret.purpose === "api_auth" && ApiConnectionSecretNameSchema.safeParse(secret.secretName).success) ||
      (secret.purpose === "db_connection" && secret.secretName === DATABASE_PASSWORD_SECRET_NAME);
    if (!valid) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["secretName"],
        message:
          secret.purpose === "agent_value"
            ? "Secret names are UPPER_SNAKE_CASE, max 64 chars."
            : "Use the reserved connection-secret key for this credential.",
      });
    }
  });
export type SecretInput = z.infer<typeof SecretInputSchema>;

const SecretArraySchema = z.array(SecretInputSchema).max(30).superRefine((secrets, ctx) => {
  const seen = new Set<string>();
  for (const [index, secret] of secrets.entries()) {
    if (seen.has(secret.secretName)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index, "secretName"],
        message: "Each credential key may appear only once.",
      });
    }
    seen.add(secret.secretName);
  }
});

/**
 * Named test user (AgentEx-style handle model): steps reference the handle in
 * natural language ("Login as expired_user"). A user without its own password
 * secret falls back to the DEFAULT_PASSWORD secret when one is defined.
 */
export const TestUserSchema = z.object({
  handle: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, "Handles are lower_snake_case, max 64 chars."),
  username: z.string().trim().min(1).max(200),
  passwordSecretName: z.string().regex(SECRET_NAME_PATTERN).nullable().default(null),
  notes: z.string().trim().max(300).default(""),
});
export type TestUserInput = z.infer<typeof TestUserSchema>;

const HttpUrlSchema = z
  .string()
  .trim()
  .url()
  .max(2_000)
  .refine((value) => {
    try {
      const protocol = new URL(value).protocol;
      return protocol === "http:" || protocol === "https:";
    } catch {
      return false;
    }
  }, "Use an HTTP or HTTPS URL.")
  .refine((value) => {
    try {
      const parsed = new URL(value);
      return parsed.username.length === 0 && parsed.password.length === 0;
    } catch {
      return false;
    }
  }, "Do not place credentials in a URL; use encrypted credential fields.");

export const ApiAuthConfigSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  z.object({ type: z.literal("bearer") }),
  z.object({
    type: z.literal("api_key"),
    location: z.enum(["header", "query"]),
    name: z.string().trim().min(1).max(120),
  }),
  z.object({
    type: z.literal("basic"),
    username: z.string().trim().min(1).max(200),
  }),
  z.object({
    type: z.literal("oauth2_client_credentials"),
    tokenUrl: HttpUrlSchema,
    clientId: z.string().trim().min(1).max(500),
    scopes: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
    audience: z.string().trim().max(500).optional(),
  }),
]);
export type ApiAuthConfig = z.infer<typeof ApiAuthConfigSchema>;

export const ApiContractSelectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("revision"), revisionId: z.string().trim().min(1).max(200) }),
  z.object({ kind: z.literal("same_origin_url"), url: HttpUrlSchema }),
]);
export type ApiContractSelection = z.infer<typeof ApiContractSelectionSchema>;

export const ApiEnvironmentConfigSchema = z
  .object({
    baseUrl: HttpUrlSchema,
    contract: ApiContractSelectionSchema.nullable().default(null),
    auth: ApiAuthConfigSchema.default({ type: "none" }),
    requestTimeoutMs: z.number().int().min(500).max(60_000).default(30_000),
    mutationMode: z.enum(["disabled", "approved_catalog"]).default("disabled"),
  })
  .superRefine((config, ctx) => {
    if (config.contract?.kind !== "same_origin_url") return;
    let sameOrigin = false;
    try {
      sameOrigin = new URL(config.contract.url).origin === new URL(config.baseUrl).origin;
    } catch {
      // The field-level URL issue is more specific; keep this refinement fail-closed.
    }
    if (!sameOrigin) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["contract", "url"],
        message: "The OpenAPI URL must use the API base URL origin.",
      });
    }
  });
export type ApiEnvironmentConfig = z.infer<typeof ApiEnvironmentConfigSchema>;

const DatabaseSchemaNameSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z_][A-Za-z0-9_$]{0,127}$/, "Use a valid database schema name.");

export const DatabaseEnvironmentConfigSchema = z.object({
  driver: z.enum(["postgres", "sqlserver", "mysql"]),
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65_535),
  databaseName: z.string().trim().min(1).max(255),
  username: z.string().trim().min(1).max(255),
  tlsMode: z.enum(["disable", "require", "verify-full"]).default("require"),
  schemas: z.array(DatabaseSchemaNameSchema).min(1).max(30),
  accessMode: z.enum(["read_only", "cataloged_dml"]).default("read_only"),
  connectTimeoutMs: z.number().int().min(500).max(60_000).default(10_000),
  statementTimeoutMs: z.number().int().min(500).max(60_000).default(30_000),
});
export type DatabaseEnvironmentConfig = z.infer<typeof DatabaseEnvironmentConfigSchema>;

const OptionalHttpUrlSchema = z.union([z.literal(""), HttpUrlSchema]);

const EnvironmentConfigFieldsSchema = z.object({
  name: z.string().trim().min(1).max(120),
  initialUrl: OptionalHttpUrlSchema.default(""),
  allowedOrigin: OptionalHttpUrlSchema.default(""),
  viewportWidth: z.number().int().min(320).max(3840).default(1280),
  viewportHeight: z.number().int().min(320).max(3840).default(720),
  headless: z.boolean().default(true),
  defaultTimeoutMs: z.number().int().min(500).max(60_000).default(10_000),
  navigationTimeoutMs: z.number().int().min(1_000).max(120_000).default(30_000),
  evidenceLevel: z.enum(["minimal", "on_failure", "all_steps"]).default("on_failure"),
  loginPlan: NaturalPlanSchema.nullable().default(null),
  /** session = reuse a captured, encrypted browser session when still valid. */
  loginMode: z.enum(["session", "fresh"]).default("session"),
  /** Authenticated-only landmark text; required for session reuse (never URL-based). */
  loggedInText: z.string().trim().max(200).default(""),
  /** Free-text guidance for the execution agent — context, never an override of the safety rules. */
  executionNotes: z.string().trim().max(2_000).default(""),
  users: z.array(TestUserSchema).max(30).default([]),
  api: ApiEnvironmentConfigSchema.nullable().default(null),
  database: DatabaseEnvironmentConfigSchema.nullable().default(null),
});

function validateEnvironmentTargets(
  config: Pick<z.infer<typeof EnvironmentConfigFieldsSchema>, "initialUrl" | "allowedOrigin" | "loginPlan" | "api" | "database">,
  ctx: z.RefinementCtx,
): void {
  const hasInitialUrl = config.initialUrl.length > 0;
  const hasAllowedOrigin = config.allowedOrigin.length > 0;
  if (hasInitialUrl !== hasAllowedOrigin) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: hasInitialUrl ? ["allowedOrigin"] : ["initialUrl"],
      message: "Initial URL and allowed origin must be configured together.",
    });
  }
  if (!hasInitialUrl && !config.api && !config.database) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["initialUrl"],
      message: "Configure at least one web, API, or database target.",
    });
  }
  if (!hasInitialUrl && config.loginPlan) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["loginPlan"],
      message: "A login plan requires a configured web UI target.",
    });
  }
}

export const EnvironmentConfigInputSchema = EnvironmentConfigFieldsSchema.superRefine(
  validateEnvironmentTargets,
);
export type EnvironmentConfigInput = z.infer<typeof EnvironmentConfigInputSchema>;

export const EnvironmentCreateSchema = z.object({
  config: EnvironmentConfigInputSchema,
  secrets: SecretArraySchema.default([]),
});

export const EnvironmentUpdateSchema = z.object({
  config: EnvironmentConfigFieldsSchema.partial().optional(),
  /** Write-only upsert; values are never returned. */
  upsertSecrets: SecretArraySchema.default([]),
  removeSecretNames: z.array(z.string().trim().min(1).max(64)).max(30).default([]),
});

/** One case selected or authored in the Test Scope step. */
export const RunCaseInputSchema = z.object({
  title: z.string().trim().min(1).max(300),
  sourceKind: z.enum(["azure_test_case", "manual"]),
  azureTestCaseId: z.string().trim().regex(/^\d+$/).nullable().default(null),
  plan: NaturalPlanSchema,
});
export type RunCaseInput = z.infer<typeof RunCaseInputSchema>;

export const RunEnvironmentSelectionSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("profile"), environmentProfileId: z.string().min(1) }),
  z.object({
    mode: z.literal("one_time"),
    config: EnvironmentConfigFieldsSchema.omit({ name: true }).superRefine(validateEnvironmentTargets),
    secrets: SecretArraySchema.default([]),
  }),
]);

export const RunCreateSchema = z.object({
  environment: RunEnvironmentSelectionSchema,
  story: z
    .object({
      workItemId: z.string().trim().regex(/^\d+$/),
      title: z.string().trim().max(500).default(""),
    })
    .nullable()
    .default(null),
  cases: z.array(RunCaseInputSchema).min(1).max(50),
  /** Approved, immutable operation revisions to pin into the run snapshot. */
  capabilityRevisionIds: z.array(z.string().trim().min(1).max(200)).max(200).default([]),
});

export const WorkspaceEgressRuleInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    targetKind: z.enum(["api", "database", "oauth", "openapi"]),
    protocol: z.enum(["http", "https", "tcp"]),
    hostPattern: z.string().trim().min(1).max(255),
    portFrom: z.number().int().min(1).max(65_535),
    portTo: z.number().int().min(1).max(65_535),
    allowPrivateNetwork: z.boolean().default(false),
    enabled: z.boolean().default(true),
  })
  .refine((rule) => rule.portTo >= rule.portFrom, {
    path: ["portTo"],
    message: "The ending port must be greater than or equal to the starting port.",
  });
export type WorkspaceEgressRuleInput = z.infer<typeof WorkspaceEgressRuleInputSchema>;

export const IntegrationOperationRevisionInputSchema = z
  .object({
    stableKey: z.string().trim().regex(/^[a-z][a-z0-9_.-]{0,119}$/),
    displayName: z.string().trim().min(1).max(200),
    revision: z.number().int().positive(),
    layer: z.enum(["api", "db"]),
    sourceKind: z.enum(["manual", "openapi"]),
    safetyClass: z.enum(["read", "mutation"]),
    databaseDriver: z.enum(["postgres", "sqlserver", "mysql"]).nullable().default(null),
    apiContractRevisionId: z.string().trim().min(1).nullable().default(null),
    parameterSchema: z.record(z.unknown()).default({}),
    definition: z.record(z.unknown()),
    approvalStatus: z.enum(["draft", "approved", "archived"]).default("draft"),
  })
  .superRefine((operation, ctx) => {
    if ((operation.layer === "db") !== Boolean(operation.databaseDriver)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["databaseDriver"],
        message: "Database operations require a driver; API operations must not set one.",
      });
    }
    const contractSourceIsValid = operation.sourceKind === "openapi"
      ? operation.layer === "api" && Boolean(operation.apiContractRevisionId)
      : operation.apiContractRevisionId === null;
    if (!contractSourceIsValid) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["apiContractRevisionId"],
        message: "OpenAPI operations require a contract revision; manual operations must not set one.",
      });
    }
  });
export type IntegrationOperationRevisionInput = z.infer<
  typeof IntegrationOperationRevisionInputSchema
>;
