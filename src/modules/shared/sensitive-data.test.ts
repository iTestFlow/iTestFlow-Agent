import { describe, expect, it } from "vitest";

import {
  collectSensitiveValues,
  isForbiddenRequestHeader,
  isSensitiveKey,
  redactExactValuesDeep,
  redactSensitiveKeysDeep,
} from "./sensitive-data";

describe("isSensitiveKey (anchored suffix matching)", () => {
  it.each([
    // single-word suffixes across casing/separator variants
    "token", "accessToken", "refresh_token", "REFRESH-TOKEN", "idToken",
    "secret", "clientSecret", "client_secret", "secrets",
    "password", "PASSWORD", "userPassword", "passwords", "passwd", "pwd",
    "credential", "credentials", "authorization", "Authorization",
    "cookie", "cookies", "ssn", "otp", "pat",
    // phrase suffixes, including prefixed forms
    "api-key", "api_key", "apiKey", "x-api-key", "X-API-Key", "my-api-key", "apiKeys",
    "private-key", "privateKey",
    "session-id", "session_id", "sessionId",
    "session-token", "sessionToken",
    "pass-hash", "pass_hash", "password_hash", "passwordHash",
    "set-cookie", "Set-Cookie",
    // exact keys
    "session", "tokens",
  ])("classifies %s as sensitive", (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each([
    // anchored non-matches: substring matching would wrongly redact these
    "tokenCount", "sessionTimeout", "cookieBannerEnabled",
    "public-key", "publicKey",
    "totalTokens", "inputTokens", "outputTokens",
    "patience", "format", "expat",
    "secretary",
    "passageway",
    "id", "key", "name", "status", "count",
    "tokenizer",
  ])("classifies %s as NOT sensitive", (key) => {
    expect(isSensitiveKey(key)).toBe(false);
  });
});

describe("redactSensitiveKeysDeep", () => {
  it("redacts nested objects and arrays with the given marker", () => {
    const input = {
      user: { name: "pat smith", password: "hunter2" },
      headers: [{ "x-api-key": "abc" }, { accept: "json" }],
      usage: { totalTokens: 42 },
    };
    expect(redactSensitiveKeysDeep(input, "[REDACTED]")).toEqual({
      user: { name: "pat smith", password: "[REDACTED]" },
      headers: [{ "x-api-key": "[REDACTED]" }, { accept: "json" }],
      usage: { totalTokens: 42 },
    });
  });

  it("caps recursion depth", () => {
    let deep: Record<string, unknown> = { done: true };
    for (let index = 0; index < 20; index += 1) deep = { child: deep };
    const output = JSON.stringify(redactSensitiveKeysDeep(deep));
    expect(output).toContain("<truncated>");
  });
});

describe("collectSensitiveValues", () => {
  it("collects scalars under sensitive keys, including nested structures", () => {
    const values = collectSensitiveValues({
      auth: { token: "tok-123", meta: { issued: 5 } },
      otp: "123456",
      credentials: { user: "alice", pin: 9911 },
      orderNumber: "123456",
      enabled: true,
    });
    expect(values.has("tok-123")).toBe(true);
    expect(values.has("123456")).toBe(true);
    // everything below a sensitive key is sensitive
    expect(values.has("alice")).toBe(true);
    expect(values.has("9911")).toBe(true);
    // booleans and non-sensitive scalars are not collected as values
    expect(values.has("true")).toBe(false);
    expect(values.has("5")).toBe(false);
  });
});

describe("redactExactValuesDeep (two-tier value redaction)", () => {
  it("redacts whole string scalars of any length, including 1-3 char secrets", () => {
    const secrets = new Set(["abc", "1", "long-secret-value"]);
    const output = redactExactValuesDeep(
      {
        verificationCode: "abc",
        note: "attempt 1 of 10",
        pin: "1",
        payload: { inner: "long-secret-value" },
      },
      secrets,
      "<redacted>",
    );
    expect(output).toEqual({
      verificationCode: "<redacted>",
      // free text with a coincidental short substring is untouched
      note: "attempt 1 of 10",
      pin: "<redacted>",
      payload: { inner: "<redacted>" },
    });
  });

  it("redacts numeric scalars only when the string form is >= 4 chars", () => {
    const secrets = new Set(["123456", "1"]);
    const output = redactExactValuesDeep(
      { code: 123456, count: 1, ratio: 1 },
      secrets,
      "<redacted>",
    );
    expect(output).toEqual({ code: "<redacted>", count: 1, ratio: 1 });
  });

  it("never touches booleans", () => {
    const output = redactExactValuesDeep({ flag: true, other: false }, new Set(["true"]));
    expect(output).toEqual({ flag: true, other: false });
  });

  it("a sensitive value copied into an innocent-looking key still redacts", () => {
    const document = { auth: { otp: "9137" }, echo: { friendlyField: "9137" } };
    const secrets = collectSensitiveValues(document);
    expect(redactExactValuesDeep(document, secrets, "<redacted>")).toEqual({
      auth: { otp: "<redacted>" },
      echo: { friendlyField: "<redacted>" },
    });
  });
});

describe("isForbiddenRequestHeader", () => {
  it.each([
    "authorization", "Authorization", "cookie", "host", "content-length",
    "connection", "transfer-encoding", "upgrade", "proxy-authorization",
    "forwarded", "x-forwarded-for", "x-http-method-override",
    "x-original-url", "x-rewrite-url", " Authorization ",
  ])("forbids %s", (name) => {
    expect(isForbiddenRequestHeader(name)).toBe(true);
  });

  it.each(["accept", "content-type", "if-none-match", "x-request-id"])("allows %s", (name) => {
    expect(isForbiddenRequestHeader(name)).toBe(false);
  });
});
