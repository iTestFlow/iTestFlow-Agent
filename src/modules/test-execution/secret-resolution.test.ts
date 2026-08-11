import { describe, expect, it } from "vitest";

import {
  buildScrubValues,
  buildScrubValuesFromValues,
  extractSecretReferences,
  isValidSecretName,
  substituteSecretPlaceholders,
} from "./secret-resolution";

describe("isValidSecretName", () => {
  it("accepts env-var-shaped names and rejects everything else", () => {
    expect(isValidSecretName("PASSWORD")).toBe(true);
    expect(isValidSecretName("API_KEY_2")).toBe(true);
    expect(isValidSecretName("password")).toBe(false);
    expect(isValidSecretName("2FA")).toBe(false);
    expect(isValidSecretName("WITH-DASH")).toBe(false);
    expect(isValidSecretName("A".repeat(65))).toBe(false);
  });
});

describe("extractSecretReferences", () => {
  it("finds and dedupes placeholders in order", () => {
    expect(
      extractSecretReferences("{{secret:USER}} / {{secret:PASSWORD}} / {{secret:USER}}"),
    ).toEqual(["USER", "PASSWORD"]);
  });

  it("ignores malformed placeholders", () => {
    expect(extractSecretReferences("{{secret:lower}} {{secret}} {secret:X}")).toEqual([]);
  });
});

describe("substituteSecretPlaceholders", () => {
  const secrets = new Map([["PASSWORD", "s3cr3t-value"]]);

  it("replaces known placeholders", () => {
    const result = substituteSecretPlaceholders("pw={{secret:PASSWORD}}", secrets);
    expect(result.value).toBe("pw=s3cr3t-value");
    expect(result.missing).toEqual([]);
  });

  it("leaves unknown placeholders intact and reports them", () => {
    const result = substituteSecretPlaceholders("{{secret:PASSWORD}} {{secret:OTP}}", secrets);
    expect(result.value).toBe("s3cr3t-value {{secret:OTP}}");
    expect(result.missing).toEqual(["OTP"]);
  });
});

describe("buildScrubValues", () => {
  it("includes raw, uri-encoded, and base64 representations", () => {
    const values = buildScrubValues(new Map([["K", "p@ss word"]]));
    expect(values).toContain("p@ss word");
    expect(values).toContain(encodeURIComponent("p@ss word"));
    expect(values).toContain(Buffer.from("p@ss word", "utf8").toString("base64"));
  });

  it("retains short values for delimiter-aware scrubbing", () => {
    expect(buildScrubValues(new Map([["K", "pw"]]))).toContain("pw");
  });

  it("includes the inner JSON-escaped representation without breaking JSON quoting", () => {
    const secret = "line one\nquoted \"value\"";
    const escaped = JSON.stringify(secret).slice(1, -1);
    expect(buildScrubValues(new Map([["K", secret]]))).toContain(escaped);
  });

  it("can include short values that were dynamically classified as sensitive", () => {
    expect(buildScrubValuesFromValues(["pin"], { minimumLength: 1 })).toContain("pin");
  });
});
