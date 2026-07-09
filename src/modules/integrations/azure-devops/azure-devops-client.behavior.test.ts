import { describe, expect, it, vi } from "vitest";

import { isIntegrationError } from "@/modules/integrations/core/integration-error";
import { ProjectIsolationError, workItemNotInProjectMessage } from "@/modules/projects/project-isolation.guard";
import { AzureDevOpsRestAdapter } from "./azure-devops-client";

const ORG = "https://dev.azure.com/fabrikam";

// Every adapter here is bound to a project scope so the isolation branch is active:
// by-ID reads/writes must be validated against this project because Azure DevOps
// ignores the project segment of by-ID URLs.
function scopedAdapter() {
  return new AzureDevOpsRestAdapter(
    { organizationUrl: ORG, personalAccessToken: "pat" },
    { azureProjectId: "proj-guid-1", azureProjectName: "Fabrikam Project" },
  );
}

// The stubs narrow fetch's signature, so recover the full (url, init) call shape here.
function fetchCallOf(mock: { mock: { calls: unknown[][] } }, index: number): { url: string; init: RequestInit | undefined } {
  const call = mock.mock.calls[index] as [RequestInfo | URL, RequestInit | undefined] | undefined;
  if (!call) throw new Error(`fetch call ${index} was never made`);
  return { url: String(call[0]), init: call[1] };
}

describe("AzureDevOpsRestAdapter project isolation", () => {
  it("rejects a by-ID work item whose System.TeamProject is another project", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      id: 42,
      fields: { "System.TeamProject": "Intruder Project", "System.Title": "Leaked item" },
    })));

    const pending = scopedAdapter().fetchWorkItemById({ projectId: "proj-guid-1", workItemId: "42" });
    await expect(pending).rejects.toBeInstanceOf(ProjectIsolationError);
    // Cross-project must be indistinguishable from not-found: canonical message only.
    await expect(pending).rejects.toThrow(workItemNotInProjectMessage("42"));
  });

  it("accepts a work item whose team project matches case-insensitively", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      id: 42,
      fields: { "System.TeamProject": "  FABRIKAM project ", "System.Title": "In scope" },
    })));

    await expect(
      scopedAdapter().fetchWorkItemById({ projectId: "proj-guid-1", workItemId: "42" }),
    ).resolves.toMatchObject({ id: "42", title: "In scope" });
  });

  it("filters cross-project items out of batch fetches per item", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `${ORG}/proj-guid-1/_apis/wit/workitemsbatch?api-version=7.1`) {
        return jsonResponse({
          value: [
            { id: 101, fields: { "System.TeamProject": "Fabrikam Project", "System.Title": "Ours" } },
            { id: 102, fields: { "System.TeamProject": "Intruder Project", "System.Title": "Theirs" } },
          ],
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const items = await scopedAdapter().fetchWorkItemsByIds({
      projectId: "proj-guid-1",
      workItemIds: ["101", "102", "abc"],
    });

    expect(items.map((item) => item.id)).toEqual(["101"]);
    // Non-integer IDs are dropped before the request is ever issued.
    const body = JSON.parse(String(fetchCallOf(fetchMock, 0).init?.body));
    expect(body).toEqual({ ids: [101, 102], $expand: "Relations" });
  });

  it("blocks the comment write when the ownership pre-check fails", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `${ORG}/proj-guid-1/_apis/wit/workitems/55?fields=System.TeamProject&api-version=7.1`) {
        return jsonResponse({ id: 55, fields: { "System.TeamProject": "Intruder Project" } });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await scopedAdapter().addWorkItemComment({
      projectId: "proj-guid-1",
      workItemId: "55",
      commentBody: "should never be posted",
    });

    expect(result).toEqual({ success: false, error: workItemNotInProjectMessage("55") });
    // Only the ownership pre-check fired; the comment POST never happened.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("AzureDevOpsRestAdapter WIQL query building", () => {
  it("escapes single quotes in every user-supplied WIQL value", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ workItems: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await scopedAdapter().fetchWorkItems({
      projectId: "proj-guid-1",
      workItemTypes: ["User's Story"],
      states: ["Won't Fix"],
      areaPath: "Fabrikam\\Team's Area",
      assignedTo: "o'brien@example.com",
    });

    expect(fetchCallOf(fetchMock, 0).url).toBe(`${ORG}/proj-guid-1/_apis/wit/wiql?api-version=7.1`);
    const { query } = JSON.parse(String(fetchCallOf(fetchMock, 0).init?.body)) as { query: string };
    expect(query).toContain("[System.WorkItemType] IN ('User''s Story')");
    expect(query).toContain("[System.State] IN ('Won''t Fix')");
    expect(query).toContain("[System.AreaPath] UNDER 'Fabrikam\\Team''s Area'");
    expect(query).toContain("[System.AssignedTo] = 'o''brien@example.com'");
    // No unescaped quote survives to terminate a WIQL string literal early.
    expect(query).not.toMatch(/[^']'s /);
  });
});

describe("AzureDevOpsRestAdapter transient retry", () => {
  it("honors a numeric Retry-After header before retrying a 503", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("busy", { status: 503, headers: { "retry-after": "2" } }))
      .mockResolvedValueOnce(jsonResponse({ value: [{ id: "p1", name: "Fabrikam Project" }] }));
    vi.stubGlobal("fetch", fetchMock);

    const pending = scopedAdapter().fetchProjects();
    // Retry-After "2" => 2000ms: the retry must not fire before the deadline.
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject([{ id: "p1", name: "Fabrikam Project" }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a thrown network failure and succeeds on the next attempt", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(jsonResponse({ value: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const pending = scopedAdapter().fetchProjects();
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries two thrown network failures and succeeds on the third attempt", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockRejectedValueOnce(new Error("ETIMEDOUT"))
      .mockResolvedValueOnce(jsonResponse({ value: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const pending = scopedAdapter().fetchProjects();
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("wraps repeated thrown network failures as an IntegrationError with cause", async () => {
    vi.useFakeTimers();
    const cause = new Error("ECONNRESET");
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(cause);
    vi.stubGlobal("fetch", fetchMock);

    const pending = scopedAdapter().fetchProjects();
    const captured = pending.catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    const caught = await captured;

    expect(isIntegrationError(caught)).toBe(true);
    if (!isIntegrationError(caught)) throw new Error("Expected an IntegrationError.");
    expect(caught.message).toBe("ECONNRESET");
    expect(caught.providerId).toBe("azure-devops");
    expect(caught.code).toBe("integration_unavailable");
    expect((caught as Error & { cause?: unknown }).cause).toBe(cause);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("gives up after three transient attempts and surfaces the Azure error", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ message: "throttled" }, { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);

    const pending = scopedAdapter().fetchProjects();
    const assertion = expect(pending).rejects.toThrow("Azure DevOps request failed (429): throttled");
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry non-transient failures", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ message: "TF401232: item missing" }, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      scopedAdapter().fetchWorkItemById({ projectId: "proj-guid-1", workItemId: "9" }),
    ).rejects.toThrow("Azure DevOps request failed (404): TF401232: item missing");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("AzureDevOpsRestAdapter pagination", () => {
  it("follows x-ms-continuationtoken across test suite pages", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `${ORG}/proj-guid-1/_apis/testplan/Plans/77/suites?api-version=7.1`) {
        return jsonResponse(
          { value: [{ id: 1, name: "Root suite" }] },
          { headers: { "x-ms-continuationtoken": "page-2" } },
        );
      }
      if (url === `${ORG}/proj-guid-1/_apis/testplan/Plans/77/suites?api-version=7.1&continuationToken=page-2`) {
        // No token on the last page ends the loop.
        return jsonResponse({ value: [{ id: 2, name: "Child suite" }] });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const suites = await scopedAdapter().fetchTestSuites({ projectId: "proj-guid-1", testPlanId: "77" });

    expect(suites).toMatchObject([
      { id: "1", name: "Root suite", planId: "77" },
      { id: "2", name: "Child suite", planId: "77" },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("AzureDevOpsRestAdapter response handling", () => {
  const authFailedMessage =
    "Azure DevOps authentication failed. Check that your Personal Access Token is valid and has not expired, then sign in again.";

  // PAT expiry is signaled through the onUnauthorized constructor hook.
  function hookedAdapter(onUnauthorized: () => void) {
    return new AzureDevOpsRestAdapter(
      { organizationUrl: ORG, personalAccessToken: "pat" },
      { azureProjectId: "proj-guid-1", azureProjectName: "Fabrikam Project" },
      { onUnauthorized },
    );
  }

  it("fires the onUnauthorized hook on a 401 and still rejects with the auth failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ message: "TF400813: not authorized" }, { status: 401 })));
    const onUnauthorized = vi.fn();

    await expect(hookedAdapter(onUnauthorized).fetchProjects()).rejects.toThrow(authFailedMessage);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("fires the onUnauthorized hook when a no-content endpoint returns 401", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/_apis/testplan/plans/10?")) {
        return jsonResponse({ project: { id: "proj-guid-1" } });
      }
      return new Response("", { status: 401 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const onUnauthorized = vi.fn();

    // deleteTestSuite reports failures as a result object, but the hook must still fire.
    await expect(hookedAdapter(onUnauthorized).deleteTestSuite({
      projectId: "proj-guid-1",
      testPlanId: "10",
      testSuiteId: "30",
    })).resolves.toEqual({ success: false, error: authFailedMessage });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("rejects a 200 response that is not JSON, such as an HTML sign-in page", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>Sign in</html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    })));

    await expect(scopedAdapter().fetchProjects()).rejects.toThrow(
      "Azure DevOps returned a non-JSON response (200). Check that the organization URL and Personal Access Token are valid.",
    );
  });

  it("rejects a 200 application/json response whose body does not parse", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"value": [', {
      status: 200,
      headers: { "content-type": "application/json" },
    })));

    await expect(scopedAdapter().fetchProjects()).rejects.toThrow(
      "Azure DevOps returned malformed JSON (200). Check that the organization URL and Personal Access Token are valid.",
    );
  });
});

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      "content-type": "application/json",
      ...(init.headers instanceof Headers ? Object.fromEntries(init.headers.entries()) : init.headers),
    },
  });
}
