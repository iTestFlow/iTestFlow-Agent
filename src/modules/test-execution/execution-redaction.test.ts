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

  it("redacts free-form browser typing text even when the value has no secret-shaped prefix", () => {
    expect(sanitizeExecutionPayload({ text: "hunter2", selector: "#password" })).toEqual({ text: "[REDACTED]", selector: "#password" });
  });

  it("scrubs exact secret values from payload strings and errors regardless of key", () => {
    const secrets = ["Sup3rS3cret!", "ab"];
    const payload = sanitizeExecutionPayload(
      { snapshot: "The field shows Sup3rS3cret! and the label ab stays.", nested: ["typed Sup3rS3cret! twice Sup3rS3cret!"] },
      secrets,
    );
    expect(JSON.stringify(payload)).not.toContain("Sup3rS3cret!");
    expect(JSON.stringify(payload)).toContain("label ab stays");
    expect(sanitizeExecutionError("navigation failed after typing Sup3rS3cret!", secrets)).not.toContain("Sup3rS3cret!");
  });
});
