import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encryptSecret } from "@/modules/security/encryption.service";
import { buildAcceptanceCriteriaContract } from "./acceptance-criteria-contract";
import { createManualDraftToken, verifyManualDraftManifest, verifyManualDraftToken } from "./manual-draft-token";

const previousKey = process.env.APP_ENCRYPTION_KEY;
const binding = { userId: "user-1", workspaceId: "ws-1", projectId: "project-1", integrationProvider: "azure-devops", storyId: "101" };
const contract = buildAcceptanceCriteriaContract({ title: "Story", acceptanceCriteria: "- First criterion\n- Second criterion" });

describe("manual Test Case Design draft token", () => {
  beforeEach(() => { process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64"); });
  afterEach(() => { if (previousKey === undefined) delete process.env.APP_ENCRYPTION_KEY; else process.env.APP_ENCRYPTION_KEY = previousKey; });

  it("accepts only the same source and scope before the 24-hour expiry", () => {
    const token = createManualDraftToken(binding, contract, ["WI:101", "AC-001", "AC-002"], 1000);
    expect(() => verifyManualDraftToken(token, binding, contract, 1000 + 24 * 60 * 60 * 1000 - 1)).not.toThrow();
    expect(() => verifyManualDraftToken(token, binding, contract, 1000 + 24 * 60 * 60 * 1000)).toThrowError(/expired/i);
    expect(() => verifyManualDraftToken(token, { ...binding, userId: "other" }, contract, 2000)).toThrowError(/different user/i);
    expect(() => verifyManualDraftToken(token, { ...binding, integrationProvider: "jira-cloud" }, contract, 2000)).toThrowError(/different user/i);
    expect(() => verifyManualDraftToken(token, { ...binding, projectId: "project-2" }, contract, 2000)).toThrowError(/different user/i);
    expect(() => verifyManualDraftToken(token, binding, buildAcceptanceCriteriaContract({ title: "Changed", acceptanceCriteria: "- First criterion\n- Second criterion" }), 2000)).toThrowError(/story changed/i);
    expect(() => verifyManualDraftToken(`${token}tampered`, binding, contract, 2000)).toThrowError(/invalid/i);
  });
});


describe("manual source manifest binding", () => {
  beforeEach(() => { process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64"); });
  afterEach(() => { if (previousKey === undefined) delete process.env.APP_ENCRYPTION_KEY; else process.env.APP_ENCRYPTION_KEY = previousKey; });
  it("authenticates a large manifest compactly and rejects added or removed sources", () => {
    const sources = Array.from({ length: 2000 }, (_, index) => `KB:business_rule:rule-${index}`);
    const token = createManualDraftToken(binding, contract, sources, 1000);
    expect(token.length).toBeLessThanOrEqual(8192);
    const draft = verifyManualDraftToken(token, binding, contract, 2000);
    expect(verifyManualDraftManifest(draft, sources.slice().reverse())).toHaveLength(2000);
    expect(() => verifyManualDraftManifest(draft, [...sources, "WI:forged"])).toThrow(/manifest/);
    expect(() => verifyManualDraftManifest(draft, sources.slice(1))).toThrow(/manifest/);
    expect(() => verifyManualDraftManifest(draft, undefined)).toThrow(/manifest/);
  });
  it("rejects authentic older drafts with a fresh-prompt recovery message", () => {
    const payload = { purpose: "test-case-design-manual-draft", ...binding, contractVersion: contract.version, sourceHash: contract.sourceHash, expiresAt: 999999 };
    const token = Buffer.from(JSON.stringify(encryptSecret(JSON.stringify(payload)))).toString("base64url");
    expect(() => verifyManualDraftToken(token, binding, contract, 2000)).toThrow(/older output contract.*pasted response remains/);
  });
});
