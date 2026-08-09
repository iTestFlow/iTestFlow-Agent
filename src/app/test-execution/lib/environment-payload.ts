import type { NaturalStep } from "@/modules/test-execution/action-schema";

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
  existingSecretCount = 0,
): string | null {
  if (parts.users.length > 30) {
    return "Too many test users — at most 30 including the default sign-in user.";
  }
  if (parts.secrets.length + existingSecretCount > 30) {
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
