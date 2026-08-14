import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZephyrScaleBackend } from "./zephyr-scale-backend";

describe("ZephyrScaleBackend", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("uses the allowlisted regional endpoint and bounded cursor pagination", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ values: [{ id: 1, key: "QA-T1", name: "First", project: { key: "QA" } }], nextStartAtId: 2 }))
      .mockResolvedValueOnce(json({ values: [{ id: 2, key: "QA-T2", name: "Last", project: { key: "QA" } }], isLast: true }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(backend("eu").listTestCases(2)).resolves.toEqual([
      { id: "QA-T1", name: "First", raw: expect.any(Object) }, { id: "QA-T2", name: "Last", raw: expect.any(Object) },
    ]);
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://eu.api.zephyrscale.smartbear.com/v2/testcases?projectKey=QA&limit=2");
    expect(String(fetchMock.mock.calls[1][0])).toContain("startAtId=2");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ cache: "no-store", headers: { Authorization: "Bearer opaque-token" } });
    expect(fetchMock.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("keeps the request timeout active until the response body is consumed", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      signal = init.signal as AbortSignal;
      return {
        ok: true,
        status: 200,
        json: () => new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true })),
      } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    const request = backend().listTestCycles();
    const rejection = expect(request).rejects.toThrow("Zephyr Scale is unavailable.");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(signal?.aborted).toBe(true);
    await rejection;
    vi.useRealTimers();
  });

  it("recovers or creates a stable Test Case then overwrites its ordered steps", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ values: [], isLast: true }))
      .mockResolvedValueOnce(json({ id: 1, key: "QA-T1" }, 201))
      .mockResolvedValueOnce(json({ id: 1 }, 201));
    vi.stubGlobal("fetch", fetchMock);
    await expect(backend().createTestCase({ projectId: "QA", testCase: {
      localId: "case-1", targetUserStoryId: "QA-7", title: "Checkout", description: "Pay", preconditions: "Cart", steps: [{ action: "Submit", expectedResult: "Created" }],
    } })).resolves.toEqual({ success: true, azureTestCaseId: "QA-T1" });
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toMatchObject({ projectKey: "QA", name: "Checkout", customFields: { "iTestFlow ID": "case-1" } });
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toEqual({ mode: "OVERWRITE", items: [{ inline: { description: "Submit", testData: "", expectedResult: "Created" } }] });
  });

  it("recovers a stable Cycle and upserts the natural Case-Cycle execution identity", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ values: [{ key: "QA-R1", project: { key: "QA" }, customFields: { "iTestFlow ID": "cycle-1" } }], isLast: true }))
      .mockResolvedValueOnce(json({ key: "QA-T1", project: { key: "QA" } }))
      .mockResolvedValueOnce(json({ key: "QA-R1", project: { key: "QA" } }))
      .mockResolvedValueOnce(json({ values: [{ id: 9, key: "QA-E1", project: { key: "QA" }, testCase: { key: "QA-T1" }, testCycle: { key: "QA-R1" } }], isLast: true }))
      .mockResolvedValueOnce(json({ id: 9, key: "QA-E1" }))
      .mockResolvedValueOnce(json({ id: 9 }));
    vi.stubGlobal("fetch", fetchMock);
    const zephyr = backend();
    await expect(zephyr.createTestCycle({ projectId: "QA", localId: "cycle-1", name: "Release" })).resolves.toBe("QA-R1");
    await expect(zephyr.reconcileExecution({ projectId: "QA", testCaseKey: "QA-T1", testCycleKey: "QA-R1", statusName: "Pass", stepResults: [{ statusName: "Pass", actualResult: "Created" }] })).resolves.toBe("QA-E1");
    expect(fetchMock.mock.calls[4][1]?.method).toBe("PUT");
    expect(JSON.parse(String(fetchMock.mock.calls[4][1]?.body))).toMatchObject({ statusName: "Pass" });
    expect(fetchMock.mock.calls[5][1]?.method).toBe("PUT");
    expect(JSON.parse(String(fetchMock.mock.calls[5][1]?.body))).toEqual({ steps: [{ statusName: "Pass", actualResult: "Created" }] });
  });

  it("resolves the official numeric execution-create response to a scoped stable key", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ key: "QA-T1", project: { key: "QA" } }))
      .mockResolvedValueOnce(json({ key: "QA-R1", project: { key: "QA" } }))
      .mockResolvedValueOnce(json({ values: [], isLast: true }))
      .mockResolvedValueOnce(json({ id: 9, self: "https://api.zephyrscale.smartbear.com/v2/testexecutions/9" }, 201))
      .mockResolvedValueOnce(json({ id: 9, key: "QA-E1", project: { key: "QA" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(backend().reconcileExecution({ projectId: "QA", testCaseKey: "QA-T1", testCycleKey: "QA-R1", statusName: "Pass" })).resolves.toBe("QA-E1");
    expect(String(fetchMock.mock.calls[4][0])).toContain("/testexecutions/9");
  });

  it("clears existing execution step results when an explicit empty list is provided", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ key: "QA-T1", project: { key: "QA" } }))
      .mockResolvedValueOnce(json({ key: "QA-R1", project: { key: "QA" } }))
      .mockResolvedValueOnce(json({ values: [{ id: 9, key: "QA-E1", project: { key: "QA" } }], isLast: true }))
      .mockResolvedValueOnce(json({ id: 9 }))
      .mockResolvedValueOnce(json({ id: 9 }));
    vi.stubGlobal("fetch", fetchMock);
    await backend().reconcileExecution({ projectId: "QA", testCaseKey: "QA-T1", testCycleKey: "QA-R1", statusName: "Pass", stepResults: [] });
    expect(JSON.parse(String(fetchMock.mock.calls[4][1]?.body))).toEqual({ steps: [] });
  });

  it("validates project ownership before coverage linking and redacts upstream details", async () => {
    const assertJiraIssueInProject = vi.fn();
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ key: "QA-T1", project: { key: "OTHER" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(backend("us", assertJiraIssueInProject).linkTestCaseToJiraIssue({ projectId: "QA", testCaseKey: "QA-T1", jiraIssueId: 10007 })).rejects.toThrow("selected Jira project");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const failed = vi.fn().mockResolvedValueOnce(json({ message: "opaque-token leaked" }, 403));
    vi.stubGlobal("fetch", failed);
    const error = await backend().listTestCycles().catch((caught: unknown) => caught);
    expect(error).toEqual(new Error("Zephyr Scale request failed."));
    expect(String(error)).not.toContain("opaque-token");
  });

  it("fails closed when an immutable identity search reaches its safety cap with more pages", async () => {
    const values = Array.from({ length: 1000 }, (_, index) => ({ key: `QA-T${index + 1}`, project: { key: "QA" } }));
    const fetchMock = vi.fn().mockImplementation(() => json({ values, nextStartAtId: fetchMock.mock.calls.length * 1000 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(backend().createTestCase({ projectId: "QA", testCase: { localId: "missing", targetUserStoryId: "QA-7", title: "Case", steps: [] } })).rejects.toThrow("safe identity search limit");
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("checks Jira issue scope before creating an idempotent coverage link", async () => {
    const assertJiraIssueInProject = vi.fn().mockResolvedValue(undefined);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ key: "QA-T1", project: { key: "QA" } }))
      .mockResolvedValueOnce(json({ issues: [] }))
      .mockResolvedValueOnce(json({ id: 1 }, 201));
    vi.stubGlobal("fetch", fetchMock);
    await backend("us", assertJiraIssueInProject).linkTestCaseToJiraIssue({ projectId: "QA", testCaseKey: "QA-T1", jiraIssueId: 10007 });
    expect(assertJiraIssueInProject).toHaveBeenCalledWith(10007);
    expect(fetchMock.mock.calls[2][1]?.method).toBe("POST");
  });
});

function backend(region: "us" | "eu" | "au" | "de" = "us", assertJiraIssueInProject = vi.fn()) { return new ZephyrScaleBackend({ apiToken: "opaque-token", region, jiraProjectKey: "QA", localIdFieldName: "iTestFlow ID", assertJiraIssueInProject }); }
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } }); }
