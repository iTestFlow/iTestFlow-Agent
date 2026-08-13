import { describe, expect, it } from "vitest";
import { sanitizeExecutionError, sanitizeExecutionPayload } from "./execution-redaction";

describe("execution persistence redaction", () => {
  it("redacts credentials, typed values, cookies, and URL query strings recursively", () => {
    const value = sanitizeExecutionPayload({
      token: "secret-token", fields: [{ name: "Password", value: "hunter2" }],
      url: "https://example.com/path?access_token=secret#fragment", nested: { cookie: "session=secret" },
    });
    expect(JSON.stringify(value)).not.toMatch(/secret-token|hunter2|session=secret|access_token/);
    expect(value).toMatchObject({ token: "[REDACTED]", fields: [{ value: "[REDACTED]" }], url: "https://example.com/path" });
  });

  it("removes bearer and API-key shaped material from errors", () => {
    expect(sanitizeExecutionError("Authorization: Bearer abc.def.ghi sk-supersecret")).not.toMatch(/abc\.def|sk-supersecret/);
  });
});
