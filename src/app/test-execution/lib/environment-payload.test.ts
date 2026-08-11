import { describe, expect, it } from "vitest";

import {
  DEFAULT_OTP_SECRET,
  DEFAULT_PASSWORD_SECRET,
  DEFAULT_USER_HANDLE,
  API_BEARER_TOKEN_SECRET,
  DATABASE_PASSWORD_SECRET,
  buildConnectionSecrets,
  buildEnvironmentParts,
  clampEnvironmentLimits,
  defaultApiEnvironment,
  defaultDatabaseEnvironment,
  environmentReadinessIssue,
  environmentTargetLabels,
  environmentPartsLimitIssue,
  sanitizeHandle,
  slugifySecretName,
  splitDefaultUser,
  unknownStepSecrets,
  usableTestUsers,
} from "./environment-payload";

describe("slugifySecretName", () => {
  it("derives UPPER_SNAKE names from friendly labels", () => {
    expect(slugifySecretName("Admin password")).toBe("ADMIN_PASSWORD");
    expect(slugifySecretName("  Admin API key!  ")).toBe("ADMIN_API_KEY");
    expect(slugifySecretName("2fa backup code")).toBe("FA_BACKUP_CODE");
  });

  it("never returns an empty or grammar-breaking name", () => {
    expect(slugifySecretName("!!!")).toBe("CREDENTIAL");
    expect(slugifySecretName("123")).toBe("CREDENTIAL");
    expect(slugifySecretName("x".repeat(200))).toHaveLength(64);
  });
});

describe("sanitizeHandle", () => {
  it("forces the handle grammar while typing", () => {
    expect(sanitizeHandle("Expired User")).toBe("expired_user");
    expect(sanitizeHandle("2fa_user")).toBe("fa_user");
    expect(sanitizeHandle("_admin")).toBe("admin");
    expect(sanitizeHandle("a".repeat(100))).toHaveLength(64);
  });
});

describe("buildEnvironmentParts", () => {
  const base = { defaultUsername: "", defaultPassword: "", defaultOtp: "", extras: [], users: [] };

  it("maps sign-in basics to the reserved secrets and the default user", () => {
    const parts = buildEnvironmentParts({
      ...base,
      defaultUsername: " admin@example.com ",
      defaultPassword: "pw-1",
      defaultOtp: "123456",
    });
    expect(parts.secrets).toEqual([
      { secretName: DEFAULT_PASSWORD_SECRET, title: "Default password", value: "pw-1" },
      { secretName: DEFAULT_OTP_SECRET, title: "Default one-time code", value: "123456" },
    ]);
    expect(parts.users).toEqual([
      { handle: DEFAULT_USER_HANDLE, username: "admin@example.com", passwordSecretName: null, notes: "" },
    ]);
    expect(parts.validSecretNames).toEqual([DEFAULT_PASSWORD_SECRET, DEFAULT_OTP_SECRET]);
  });

  it("contributes nothing for blank sign-in fields", () => {
    const parts = buildEnvironmentParts(base);
    expect(parts.secrets).toEqual([]);
    expect(parts.users).toEqual([]);
  });

  it("auto-names extras from labels and skips incomplete rows", () => {
    const parts = buildEnvironmentParts({
      ...base,
      extras: [
        { title: "Admin API key", value: "k1" },
        { title: "No value yet", value: "" },
        { title: "", value: "orphan" },
      ],
    });
    expect(parts.secrets).toEqual([{ secretName: "ADMIN_API_KEY", title: "Admin API key", value: "k1" }]);
  });

  it("suffixes colliding derived names instead of overwriting", () => {
    const parts = buildEnvironmentParts({
      ...base,
      extras: [
        { title: "Admin key", value: "a" },
        { title: "admin KEY", value: "b" },
        { title: "Default password", value: "sneaky" },
      ],
      existingSecretNames: ["LEGACY_TOKEN"],
    });
    expect(parts.secrets.map((secret) => secret.secretName)).toEqual([
      "ADMIN_KEY",
      "ADMIN_KEY_2",
      "DEFAULT_PASSWORD_2",
    ]);
    expect(parts.validSecretNames).toContain("LEGACY_TOKEN");
  });

  it("never lets an extra overwrite an existing server-side secret", () => {
    const parts = buildEnvironmentParts({
      ...base,
      extras: [{ title: "Legacy token", value: "new" }],
      existingSecretNames: ["LEGACY_TOKEN"],
    });
    expect(parts.secrets[0].secretName).toBe("LEGACY_TOKEN_2");
  });

  it("drops a hand-typed user with the reserved default handle", () => {
    const parts = buildEnvironmentParts({
      ...base,
      defaultUsername: "admin@example.com",
      users: [
        { handle: DEFAULT_USER_HANDLE, username: "imposter@example.com", passwordSecretName: null, notes: "" },
        { handle: "expired_user", username: "expired@example.com", passwordSecretName: "MISSING", notes: "n" },
      ],
    });
    expect(parts.users).toHaveLength(2);
    expect(parts.users[0].username).toBe("admin@example.com");
    // Dangling password reference nulled at build time.
    expect(parts.users[1]).toMatchObject({ handle: "expired_user", passwordSecretName: null });
  });

  it("preserves a legacy default user's pinned password and notes via the seed", () => {
    const parts = buildEnvironmentParts({
      ...base,
      defaultUsername: "admin@example.com",
      existingSecretNames: ["MAIN_PASSWORD"],
      defaultUserSeed: { passwordSecretName: "MAIN_PASSWORD", notes: "prod admin" },
    });
    expect(parts.users[0]).toEqual({
      handle: DEFAULT_USER_HANDLE,
      username: "admin@example.com",
      passwordSecretName: "MAIN_PASSWORD",
      notes: "prod admin",
    });
    // A seed pointing at a secret that no longer survives falls back to null.
    const dropped = buildEnvironmentParts({
      ...base,
      defaultUsername: "admin@example.com",
      defaultUserSeed: { passwordSecretName: "GONE", notes: "kept" },
    });
    expect(dropped.users[0]).toMatchObject({ passwordSecretName: null, notes: "kept" });
  });

  it("dedupes friendly titles, not just derived names", () => {
    const parts = buildEnvironmentParts({
      ...base,
      extras: [
        { title: "Admin key", value: "a" },
        { title: "admin KEY", value: "b" },
      ],
    });
    expect(parts.secrets.map((secret) => secret.title)).toEqual(["Admin key", "admin KEY (2)"]);
  });
});

describe("usableTestUsers", () => {
  it("drops invalid handles and blank usernames, keeps valid references", () => {
    const users = usableTestUsers(
      [
        { handle: "good_user", username: " a@x.com ", passwordSecretName: "PW", notes: "" },
        { handle: "", username: "b@x.com", passwordSecretName: null, notes: "" },
        { handle: "no_name", username: "  ", passwordSecretName: null, notes: "" },
      ],
      ["PW"],
    );
    expect(users).toEqual([{ handle: "good_user", username: "a@x.com", passwordSecretName: "PW", notes: "" }]);
  });
});

describe("clampEnvironmentLimits", () => {
  it("clamps numeric options into schema ranges", () => {
    expect(
      clampEnvironmentLimits({
        viewportWidth: 100,
        viewportHeight: 9000,
        defaultTimeoutMs: 1,
        navigationTimeoutMs: 999_999,
      }),
    ).toEqual({ viewportWidth: 320, viewportHeight: 3840, defaultTimeoutMs: 500, navigationTimeoutMs: 120_000 });
  });
});

describe("splitDefaultUser", () => {
  it("separates the reserved default user from the visible rows", () => {
    const split = splitDefaultUser([
      { handle: DEFAULT_USER_HANDLE, username: "admin@x.com", passwordSecretName: "MAIN_PW", notes: "keep me" },
      { handle: "expired_user", username: "e@x.com", passwordSecretName: null, notes: "" },
    ]);
    expect(split.defaultUsername).toBe("admin@x.com");
    expect(split.defaultUser).toMatchObject({ passwordSecretName: "MAIN_PW", notes: "keep me" });
    expect(split.otherUsers).toHaveLength(1);
  });
});

describe("environmentPartsLimitIssue", () => {
  it("flags user and secret totals over the API caps", () => {
    const manyUsers = Array.from({ length: 31 }, (_, i) => ({
      handle: `user_${i}`,
      username: `u${i}@x.com`,
      passwordSecretName: null,
      notes: "",
    }));
    expect(
      environmentPartsLimitIssue({ secrets: [], users: manyUsers, validSecretNames: [] }),
    ).toMatch(/test users/);
    const secrets = Array.from({ length: 2 }, (_, i) => ({ secretName: `S_${i}`, title: `S ${i}`, value: "v" }));
    expect(environmentPartsLimitIssue({ secrets, users: [], validSecretNames: [] }, 29)).toMatch(/credentials/);
    expect(environmentPartsLimitIssue({ secrets, users: [], validSecretNames: [] }, 0)).toBeNull();
  });

  it("counts secret names after an update instead of double-counting replacements", () => {
    const existing = Array.from({ length: 30 }, (_, index) => `SECRET_${index}`);
    const replacement = [{ secretName: "SECRET_0", title: "Replacement", value: "new" }];
    expect(environmentPartsLimitIssue({ secrets: replacement, users: [], validSecretNames: [] }, existing)).toBeNull();
  });
});

describe("unknownStepSecrets", () => {
  it("reports tokens that reference credentials that will not exist", () => {
    const steps = [
      { instruction: "Enter {{secret:DEFAULT_PASSWORD}} then {{secret:GONE_KEY}}" },
      { instruction: "Plain step without tokens" },
    ];
    expect(unknownStepSecrets(steps, ["DEFAULT_PASSWORD"])).toEqual(["GONE_KEY"]);
    expect(unknownStepSecrets(steps, ["DEFAULT_PASSWORD", "GONE_KEY"])).toEqual([]);
  });
});

describe("multi-layer environment helpers", () => {
  it("builds purpose-scoped connection secrets without exposing them as agent credentials", () => {
    const api = { ...defaultApiEnvironment(), baseUrl: "https://api.example.com", auth: { type: "bearer" as const } };
    const database = { ...defaultDatabaseEnvironment("postgres"), host: "db.internal", databaseName: "shop", username: "qa" };
    expect(buildConnectionSecrets({ api, apiSecret: "token", database, databasePassword: "password" })).toEqual([
      {
        secretName: API_BEARER_TOKEN_SECRET,
        title: "API bearer token",
        value: "token",
        purpose: "api_auth",
      },
      {
        secretName: DATABASE_PASSWORD_SECRET,
        title: "Database password",
        value: "password",
        purpose: "db_connection",
      },
    ]);
  });

  it("requires at least one complete target and the selected connection credentials", () => {
    expect(
      environmentReadinessIssue({
        initialUrl: "",
        allowedOrigin: "",
        api: null,
        apiSecret: "",
        database: null,
        databasePassword: "",
      }),
    ).toMatch(/at least one/i);

    const api = { ...defaultApiEnvironment(), baseUrl: "https://api.example.com", auth: { type: "bearer" as const } };
    expect(
      environmentReadinessIssue({
        initialUrl: "",
        allowedOrigin: "",
        api,
        apiSecret: "",
        database: null,
        databasePassword: "",
      }),
    ).toMatch(/API credential/i);
    expect(
      environmentReadinessIssue({
        initialUrl: "",
        allowedOrigin: "",
        api,
        apiSecret: "",
        apiSecretSaved: true,
        database: null,
        databasePassword: "",
      }),
    ).toBeNull();
  });

  it("validates same-origin OpenAPI discovery and labels configured layers", () => {
    const api = {
      ...defaultApiEnvironment(),
      baseUrl: "https://api.example.com/v1",
      contract: { kind: "same_origin_url" as const, url: "https://other.example.com/openapi.json" },
    };
    expect(
      environmentReadinessIssue({
        initialUrl: "https://app.example.com",
        allowedOrigin: "https://app.example.com",
        api,
        apiSecret: "",
        database: defaultDatabaseEnvironment(),
        databasePassword: "pw",
      }),
    ).toMatch(/OpenAPI URL/i);
    expect(environmentTargetLabels({ initialUrl: "https://app.example.com", api, database: defaultDatabaseEnvironment() }))
      .toEqual(["UI", "API", "DB"]);
  });
});
