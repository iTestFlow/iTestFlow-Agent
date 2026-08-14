import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlainJiraArtifactBackend } from "./plain-jira-artifact-backend";

describe("PlainJiraArtifactBackend", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("publishes a test case with immutable local identity and deterministic backlink", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ id: "10007", key: "QA-7", fields: { project: { id: "10000", key: "QA" }, summary: "Story", issuetype: { name: "Story" } } }))
      .mockResolvedValueOnce(json({ issues: [] }))
      .mockResolvedValueOnce(json({ id: "10009", key: "QA-9" }))
      .mockResolvedValueOnce(json({}))
      .mockResolvedValueOnce(json({ comments: [], isLast: true }))
      .mockResolvedValueOnce(json({ id: "1" }));
    vi.stubGlobal("fetch", fetchMock);
    const backend = plainBackend();
    await expect(backend.createTestCase({
      projectId: "10000",
      testCase: {
        localId: "case-local-1", targetUserStoryId: "QA-7", title: "Checkout succeeds",
        description: "Covers checkout", preconditions: "Cart has items", steps: [{ action: "Pay", expectedResult: "Order created" }],
      },
    })).resolves.toEqual({ success: true, azureTestCaseId: "QA-9" });
    const createBody = JSON.parse(String(fetchMock.mock.calls[2][1]?.body));
    expect(createBody.fields).toMatchObject({
      project: { id: "10000" }, issuetype: { id: "test-case-type" }, summary: "Checkout succeeds",
      labels: ["itestflow", "itestflow-test-case"], customfield_10100: "case-local-1",
    });
    expect(String(fetchMock.mock.calls[3][0])).toMatch(/\/remotelink$/);
    const linkBody = JSON.parse(String(fetchMock.mock.calls[3][1]?.body));
    expect(linkBody).toEqual({
      globalId: "itestflow:test-case:case-local-1",
      object: { url: "https://app.example/test-cases/case-local-1", title: "iTestFlow test case case-local-1" },
    });
    expect(String(fetchMock.mock.calls[4][0])).toContain("/comment?startAt=0&maxResults=100");
    const marker = createHash("sha256").update("case-local-1", "utf8").digest("base64url");
    expect(String(fetchMock.mock.calls[5][1]?.body)).toContain(`[itestflow:test-case:${marker}]`);
    expect(String(fetchMock.mock.calls[5][1]?.body)).toContain("QA-9");
  });

  it("does not duplicate the story backlink comment when recovering an existing Jira issue", async () => {
    const localId = 'case-"slash\\1';
    const marker = `[itestflow:test-case:${createHash("sha256").update(localId, "utf8").digest("base64url")}]`;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ fields: { project: { id: "10000", key: "QA" } } }))
      .mockResolvedValueOnce(json({ issues: [{ key: "QA-9" }] }))
      .mockResolvedValueOnce(json({}))
      .mockResolvedValueOnce(json({ comments: [{ body: adf(marker) }], isLast: true }));
    vi.stubGlobal("fetch", fetchMock);

    await plainBackend().createTestCase({
      projectId: "10000",
      testCase: { localId, targetUserStoryId: "QA-7", title: "Checkout succeeds", steps: [] },
    });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST" && String(init.body).includes('"body"'))).toBe(false);
  });

  it("rejects configured identity fields that could overwrite trusted Jira fields", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const backend = new PlainJiraArtifactBackend(settings({ localIdFieldId: "summary" }), scope());
    await expect(backend.createTestCase({
      projectId: "10000", testCase: { localId: "case-1", targetUserStoryId: "QA-7", title: "Title", steps: [] },
    })).rejects.toThrow("reserved Jira field");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects malformed Jira custom-field identifiers before any request", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const backend = new PlainJiraArtifactBackend(settings({ localIdFieldId: 'customfield_10100 OR project = "OTHER"' }), scope());
    await expect(backend.createTestCase({
      projectId: "10000", testCase: { localId: "case-1", targetUserStoryId: "QA-7", title: "Title", steps: [] },
    })).rejects.toThrow("reserved Jira field");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function plainBackend() { return new PlainJiraArtifactBackend(settings(), scope()); }
function settings(overrides = {}) {
  return { cloudId: "cloud-a", siteUrl: "https://quality.atlassian.net", accessToken: "secret", appBaseUrl: "https://app.example", testCaseIssueTypeId: "test-case-type", localIdFieldId: "customfield_10100", ...overrides };
}
function scope() { return { jiraProjectId: "10000", jiraProjectKey: "QA", jiraProjectName: "Quality" }; }
function json(value: unknown) { return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } }); }
function adf(text: string) { return { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] }; }
