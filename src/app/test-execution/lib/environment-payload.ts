import type { NaturalStep } from "@/modules/test-execution/action-schema";
import {
  API_CONNECTION_SECRET_NAMES as CANONICAL_API_CONNECTION_SECRET_NAMES,
  DATABASE_PASSWORD_SECRET_NAME,
} from "@/modules/test-execution/schemas/test-execution.schemas";

/**
 * Pure payload assembly for the Environment step's simplified credential
 * model. The UI collects friendly fields (sign-in basics, Label+Value
 * extras, test users); this module turns them into the engine's contract —
 * named secrets and a user roster — so {{secret:NAME}} tokens never appear
 * in the UI. Names are derived from labels once and stay hidden.
 */
export type { NaturalStep };

export const DEFAULT_PASSWORD_SECRET = "DEFAULT_PASSWORD";
export const DEFAULT_OTP_SECRET = "DEFAULT_OTP";
export const DEFAULT_USER_HANDLE = "default";
export const RESERVED_SECRET_NAMES = new Set([DEFAULT_PASSWORD_SECRET, DEFAULT_OTP_SECRET]);

// Reserved connection-secret keys come from ONE canonical list (the API
// schema); the client only re-exports them so the two can never drift.
export const [
  API_BEARER_TOKEN_SECRET,
  API_KEY_SECRET,
  API_BASIC_PASSWORD_SECRET,
  API_OAUTH_CLIENT_SECRET,
] = CANONICAL_API_CONNECTION_SECRET_NAMES;
export const DATABASE_PASSWORD_SECRET = DATABASE_PASSWORD_SECRET_NAME;

export const API_CONNECTION_SECRET_NAMES = CANONICAL_API_CONNECTION_SECRET_NAMES;
export const CONNECTION_SECRET_NAMES = [...API_CONNECTION_SECRET_NAMES, DATABASE_PASSWORD_SECRET] as const;

export type SecretPurpose = "agent_value" | "api_auth" | "db_connection";

export type ApiAuthConfig =
  | { type: "none" }
  | { type: "bearer" }
  | { type: "api_key"; location: "header" | "query"; name: string }
  | { type: "basic"; username: string }
  | {
      type: "oauth2_client_credentials";
      tokenUrl: string;
      clientId: string;
      scopes: string[];
      audience?: string;
    };

export type ApiEnvironmentConfig = {
  baseUrl: string;
  contract: null | { kind: "revision"; revisionId: string } | { kind: "same_origin_url"; url: string };
  auth: ApiAuthConfig;
  requestTimeoutMs: number;
};

export type DatabaseEnvironmentConfig = {
  driver: "postgres" | "sqlserver" | "mysql";
  host: string;
  port: number;
  databaseName: string;
  username: string;
  /** "disable" is legacy-only: readable and preserved, never newly selectable. */
  tlsMode: "disable" | "require" | "verify-full";
  connectTimeoutMs: number;
  statementTimeoutMs: number;
};

export type ConnectionSecretInput = {
  secretName: string;
  title: string;
  value: string;
  purpose: "api_auth" | "db_connection";
};

export function defaultApiEnvironment(): ApiEnvironmentConfig {
  return {
    baseUrl: "",
    contract: null,
    auth: { type: "none" },
    requestTimeoutMs: 30_000,
  };
}

export function defaultDatabaseEnvironment(
  driver: DatabaseEnvironmentConfig["driver"] = "postgres",
): DatabaseEnvironmentConfig {
  return {
    driver,
    host: "",
    port: databaseDefaultPort(driver),
    databaseName: "",
    username: "",
    tlsMode: "verify-full",
    connectTimeoutMs: 10_000,
    statementTimeoutMs: 30_000,
  };
}

export function databaseDefaultPort(driver: DatabaseEnvironmentConfig["driver"]): number {
  return driver === "postgres" ? 5432 : driver === "sqlserver" ? 1433 : 3306;
}

export function apiAuthSecretName(auth: ApiAuthConfig): string | null {
  switch (auth.type) {
    case "bearer":
      return API_BEARER_TOKEN_SECRET;
    case "api_key":
      return API_KEY_SECRET;
    case "basic":
      return API_BASIC_PASSWORD_SECRET;
    case "oauth2_client_credentials":
      return API_OAUTH_CLIENT_SECRET;
    default:
      return null;
  }
}

/** Convert connection password/token fields held only in React memory into write-only secret inputs. */
export function buildConnectionSecrets(input: {
  api: ApiEnvironmentConfig | null;
  apiSecret: string;
  database: DatabaseEnvironmentConfig | null;
  databasePassword: string;
}): ConnectionSecretInput[] {
  const result: ConnectionSecretInput[] = [];
  const apiSecretName = input.api ? apiAuthSecretName(input.api.auth) : null;
  if (apiSecretName && input.apiSecret) {
    result.push({
      secretName: apiSecretName,
      title: apiSecretTitle(apiSecretName),
      value: input.apiSecret,
      purpose: "api_auth",
    });
  }
  if (input.database && input.databasePassword) {
    result.push({
      secretName: DATABASE_PASSWORD_SECRET,
      title: "Database password",
      value: input.databasePassword,
      purpose: "db_connection",
    });
  }
  return result;
}

export function connectionSecretNamesForConfig(input: {
  api: ApiEnvironmentConfig | null;
  database: DatabaseEnvironmentConfig | null;
}): string[] {
  const apiName = input.api ? apiAuthSecretName(input.api.auth) : null;
  return [apiName, input.database ? DATABASE_PASSWORD_SECRET : null].filter((name): name is string => Boolean(name));
}

export function environmentTargetLabels(input: {
  initialUrl: string;
  api: ApiEnvironmentConfig | null;
  database: DatabaseEnvironmentConfig | null;
}): Array<"UI" | "API" | "DB"> {
  return [input.initialUrl.trim() ? "UI" : null, input.api ? "API" : null, input.database ? "DB" : null].filter(
    (label): label is "UI" | "API" | "DB" => label !== null,
  );
}

/** Friendly client-side validation; the API remains the final authority. */
export function environmentReadinessIssue(input: {
  initialUrl: string;
  allowedOrigin: string;
  api: ApiEnvironmentConfig | null;
  apiSecret: string;
  apiSecretSaved?: boolean;
  database: DatabaseEnvironmentConfig | null;
  databasePassword: string;
  databasePasswordSaved?: boolean;
}): string | null {
  const hasUi = input.initialUrl.trim().length > 0;
  if (!hasUi && !input.api && !input.database) return "Enable at least one UI, API, or database target.";

  if (hasUi) {
    const initial = parseHttpUrl(input.initialUrl);
    const origin = parseHttpUrl(input.allowedOrigin || initial?.origin || "");
    if (!initial || !origin) return "Enter a full HTTP or HTTPS URL for the UI target.";
    if (initial.origin !== origin.origin) return "The initial URL must be inside the allowed origin.";
  }

  if (input.api) {
    const base = parseHttpUrl(input.api.baseUrl);
    if (!base) return "Enter a full HTTP or HTTPS API base URL.";
    if (input.api.contract?.kind === "revision" && !input.api.contract.revisionId.trim()) {
      return "Choose a valid API contract revision or remove the contract.";
    }
    if (input.api.contract?.kind === "same_origin_url") {
      const contract = parseHttpUrl(input.api.contract.url);
      if (!contract || contract.origin !== base.origin) return "The OpenAPI URL must use the API base URL origin.";
    }
    if (input.api.auth.type === "api_key" && !input.api.auth.name.trim()) return "Enter the API key parameter name.";
    if (input.api.auth.type === "basic" && !input.api.auth.username.trim()) return "Enter the API username.";
    if (input.api.auth.type === "oauth2_client_credentials") {
      if (!parseHttpUrl(input.api.auth.tokenUrl) || !input.api.auth.clientId.trim()) {
        return "Enter the OAuth token URL and client ID.";
      }
    }
    if (!Number.isInteger(input.api.requestTimeoutMs) || input.api.requestTimeoutMs < 500 || input.api.requestTimeoutMs > 60_000) {
      return "Enter an API request timeout from 500 to 60000 ms.";
    }
    if (apiAuthSecretName(input.api.auth) && !input.apiSecret && !input.apiSecretSaved) {
      return "Enter the API credential required by the selected authentication method.";
    }
  }

  if (input.database) {
    if (!input.database.host.trim() || !input.database.databaseName.trim() || !input.database.username.trim()) {
      return "Enter the database host, name, and username.";
    }
    if (!Number.isInteger(input.database.port) || input.database.port < 1 || input.database.port > 65_535) {
      return "Enter a database port from 1 to 65535.";
    }
    if (
      !Number.isInteger(input.database.connectTimeoutMs) ||
      input.database.connectTimeoutMs < 500 ||
      input.database.connectTimeoutMs > 60_000 ||
      !Number.isInteger(input.database.statementTimeoutMs) ||
      input.database.statementTimeoutMs < 500 ||
      input.database.statementTimeoutMs > 60_000
    ) {
      return "Enter database timeouts from 500 to 60000 ms.";
    }
    if (!input.databasePassword && !input.databasePasswordSaved) return "Enter the database password.";
  }
  return null;
}

function apiSecretTitle(secretName: string): string {
  switch (secretName) {
    case API_BEARER_TOKEN_SECRET:
      return "API bearer token";
    case API_KEY_SECRET:
      return "API key";
    case API_BASIC_PASSWORD_SECRET:
      return "API basic password";
    default:
      return "API OAuth client secret";
  }
}

function parseHttpUrl(value: string): URL | null {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : null;
  } catch {
    return null;
  }
}

export type TestUserDraft = {
  handle: string;
  username: string;
  passwordSecretName: string | null;
  notes: string;
};

export type EnvironmentSecretPart = { secretName: string; title: string; value: string };

/**
 * Force the schema's handle grammar (^[a-z][a-z0-9_]{0,63}$) while typing, so
 * a visible handle is always a submittable one — never silently dropped later.
 */
export function sanitizeHandle(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/^[^a-z]+/, "")
    .slice(0, 64);
}

/**
 * Derive the hidden secret name from a friendly label: "Admin API key" →
 * ADMIN_API_KEY. Grammar: ^[A-Z][A-Z0-9_]{0,63}$.
 */
export function slugifySecretName(title: string): string {
  const slug = title
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^[^A-Z]+/, "")
    .replace(/_+$/, "")
    .slice(0, 64);
  return slug || "CREDENTIAL";
}

/**
 * Only complete rows leave the browser — half-filled user rows are dropped,
 * not rejected — and a password reference to a secret that will not actually
 * exist after this request falls back to null so the worker's
 * DEFAULT_PASSWORD fallback stays honest.
 */
export function usableTestUsers(users: TestUserDraft[], validSecretNames: string[]): TestUserDraft[] {
  const names = new Set(validSecretNames);
  return users
    .filter((user) => /^[a-z][a-z0-9_]{0,63}$/.test(user.handle) && user.username.trim().length > 0)
    .map((user) => ({
      ...user,
      username: user.username.trim(),
      passwordSecretName:
        user.passwordSecretName && names.has(user.passwordSecretName) ? user.passwordSecretName : null,
    }));
}

export type EnvironmentPartsInput = {
  /** Sign-in details section. Blank fields simply contribute nothing. */
  defaultUsername: string;
  defaultPassword: string;
  defaultOtp: string;
  /** Extra credentials as friendly Label + Value rows. */
  extras: { title: string; value: string }[];
  /** Test-user rows from the editor (the reserved default handle is ignored). */
  users: TestUserDraft[];
  /**
   * Secret names that already exist server-side and survive this request
   * (edit mode). Extras never overwrite them — a colliding derived name gets
   * a numeric suffix instead of silently replacing an unrelated credential.
   */
  existingSecretNames?: string[];
  /**
   * A legacy default user's own password link and notes (edit mode). The
   * sign-in fields only own the username — a hand-pinned passwordSecretName
   * must survive an edit that never touched credentials.
   */
  defaultUserSeed?: { passwordSecretName: string | null; notes: string } | null;
};

export type EnvironmentParts = {
  secrets: EnvironmentSecretPart[];
  users: TestUserDraft[];
  /** Every secret name valid after this request: kept existing + new. */
  validSecretNames: string[];
};

export function buildEnvironmentParts(input: EnvironmentPartsInput): EnvironmentParts {
  const existing = input.existingSecretNames ?? [];
  const taken = new Set<string>(existing);
  const usedTitles = new Set<string>();
  const secrets: EnvironmentSecretPart[] = [];

  const addSecret = (secretName: string, title: string, value: string) => {
    // Titles must stay unique too — the agent resolves plain-English
    // mentions by label, so two "Admin key" entries would be ambiguous.
    let uniqueTitle = title;
    for (let suffix = 2; usedTitles.has(uniqueTitle.toLowerCase()); suffix++) {
      uniqueTitle = `${title} (${suffix})`;
    }
    usedTitles.add(uniqueTitle.toLowerCase());
    secrets.push({ secretName, title: uniqueTitle, value });
    taken.add(secretName);
  };

  if (input.defaultPassword) {
    addSecret(DEFAULT_PASSWORD_SECRET, "Default password", input.defaultPassword);
  }
  if (input.defaultOtp) {
    addSecret(DEFAULT_OTP_SECRET, "Default one-time code", input.defaultOtp);
  }

  for (const extra of input.extras) {
    const title = extra.title.trim();
    if (!title || !extra.value) continue;
    const base = slugifySecretName(title);
    let name = base;
    for (let suffix = 2; taken.has(name) || RESERVED_SECRET_NAMES.has(name); suffix++) {
      name = `${base.slice(0, 60)}_${suffix}`;
    }
    addSecret(name, title, extra.value);
  }

  const validSecretNames = [...new Set([...existing, ...secrets.map((secret) => secret.secretName)])];
  const validNameSet = new Set(validSecretNames);

  const users: TestUserDraft[] = [];
  if (input.defaultUsername.trim()) {
    const seedPassword = input.defaultUserSeed?.passwordSecretName ?? null;
    users.push({
      handle: DEFAULT_USER_HANDLE,
      username: input.defaultUsername.trim(),
      passwordSecretName: seedPassword && validNameSet.has(seedPassword) ? seedPassword : null,
      notes: input.defaultUserSeed?.notes ?? "",
    });
  }
  users.push(
    ...usableTestUsers(
      input.users.filter((user) => user.handle !== DEFAULT_USER_HANDLE),
      validSecretNames,
    ),
  );

  return { secrets, users, validSecretNames };
}

/**
 * The API caps users and secrets at 30 per profile/run. The UI adds hidden
 * entries (default user, reserved secrets), so a friendly pre-check beats a
 * raw "Array must contain at most 30 element(s)" from zod.
 */
export function environmentPartsLimitIssue(
  parts: EnvironmentParts,
  existingSecrets: number | string[] = 0,
): string | null {
  if (parts.users.length > 30) {
    return "Too many test users — at most 30 including the default sign-in user.";
  }
  const secretCount = Array.isArray(existingSecrets)
    ? new Set([...existingSecrets, ...parts.secrets.map((secret) => secret.secretName)]).size
    : parts.secrets.length + existingSecrets;
  if (secretCount > 30) {
    return "Too many credentials — at most 30 including the sign-in password and one-time code.";
  }
  return null;
}

/** Secret tokens referenced by steps but absent from the credentials being saved. */
export function unknownStepSecrets(steps: { instruction: string }[], validSecretNames: string[]): string[] {
  const valid = new Set(validSecretNames);
  const unknown = new Set<string>();
  for (const step of steps) {
    for (const match of step.instruction.matchAll(/\{\{secret:([A-Z][A-Z0-9_]{0,63})\}\}/g)) {
      if (!valid.has(match[1])) unknown.add(match[1]);
    }
  }
  return [...unknown];
}

export type EnvironmentDraftLimits = {
  viewportWidth: number;
  viewportHeight: number;
  defaultTimeoutMs: number;
  navigationTimeoutMs: number;
};

/** Clamp the numeric browser options into the ranges the API schema accepts. */
export function clampEnvironmentLimits<T extends EnvironmentDraftLimits>(config: T): T {
  const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
  return {
    ...config,
    viewportWidth: clamp(config.viewportWidth, 320, 3840),
    viewportHeight: clamp(config.viewportHeight, 320, 3840),
    defaultTimeoutMs: clamp(config.defaultTimeoutMs, 500, 60_000),
    navigationTimeoutMs: clamp(config.navigationTimeoutMs, 1_000, 120_000),
  };
}

/** Split a profile's stored users into the default (sign-in) user and the visible rows. */
export function splitDefaultUser(users: TestUserDraft[]): {
  defaultUsername: string;
  /** The full legacy row — its pinned password/notes must survive edits. */
  defaultUser: TestUserDraft | null;
  otherUsers: TestUserDraft[];
} {
  const defaultUser = users.find((user) => user.handle === DEFAULT_USER_HANDLE) ?? null;
  return {
    defaultUsername: defaultUser?.username ?? "",
    defaultUser,
    otherUsers: users.filter((user) => user.handle !== DEFAULT_USER_HANDLE),
  };
}
