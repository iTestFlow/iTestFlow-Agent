import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildAcceptanceCriteriaContract } from "./acceptance-criteria-contract";
import { createManualDraftToken, verifyManualDraftToken } from "./manual-draft-token";

const previousKey = process.env.APP_ENCRYPTION_KEY;
const binding = { userId: "user-1", workspaceId: "ws-1", projectId: "project-1", integrationProvider: "azure-devops", storyId: "101" };
const contract = buildAcceptanceCriteriaContract({ title: "Story", acceptanceCriteria: "- First criterion\n- Second criterion" });

describe("manual Test Case Design draft token", () => {
  beforeEach(() => { process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64"); });
  afterEach(() => { if (previousKey === undefined) delete process.env.APP_ENCRYPTION_KEY; else process.env.APP_ENCRYPTION_KEY = previousKey; });

  it("accepts only the same source and scope before the 24-hour expiry", () => {
    const token = createManualDraftToken(binding, contract, 1000);
    expect(() => verifyManualDraftToken(token, binding, contract, 1000 + 24 * 60 * 60 * 1000 - 1)).not.toThrow();
    expect(() => verifyManualDraftToken(token, binding, contract, 1000 + 24 * 60 * 60 * 1000)).toThrowError(/expired/i);
    expect(() => verifyManualDraftToken(token, { ...binding, userId: "other" }, contract, 2000)).toThrowError(/different user/i);
    expect(() => verifyManualDraftToken(token, { ...binding, integrationProvider: "jira-cloud" }, contract, 2000)).toThrowError(/different user/i);
    expect(() => verifyManualDraftToken(token, { ...binding, projectId: "project-2" }, contract, 2000)).toThrowError(/different user/i);
    expect(() => verifyManualDraftToken(token, binding, buildAcceptanceCriteriaContract({ title: "Changed", acceptanceCriteria: "- First criterion\n- Second criterion" }), 2000)).toThrowError(/story changed/i);
    expect(() => verifyManualDraftToken(`${token}tampered`, binding, contract, 2000)).toThrowError(/invalid/i);
  });
});
