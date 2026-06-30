import { afterEach, describe, expect, it, vi } from "vitest";

import { AzureDevOpsRestAdapter } from "./azure-devops-client";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("AzureDevOpsRestAdapter.fetchProjectUsers", () => {
  it("unions project-scoped Graph users with project team members", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://vssps.dev.azure.com/fabrikam/_apis/graph/descriptors/project-1?api-version=7.1-preview.1") {
        return jsonResponse({ value: "scp.project-1" });
      }
      if (url === "https://vssps.dev.azure.com/fabrikam/_apis/graph/users?scopeDescriptor=scp.project-1&api-version=7.1-preview.1") {
        return jsonResponse({
          value: [
            {
              originId: "mahmoud-origin-id",
              displayName: "Mahmoud ElSharkawy",
              principalName: "mahmoud@example.com",
            },
            {
              originId: "abdel-origin-id",
              displayName: "Abdelrahman Elliithy",
              principalName: "abdelrahman@example.com",
            },
          ],
        });
      }
      if (url === "https://dev.azure.com/fabrikam/_apis/projects/project-1/teams?api-version=7.1") {
        return jsonResponse({ value: [{ id: "team-1", name: "Test Team" }] });
      }
      if (url === "https://dev.azure.com/fabrikam/_apis/projects/project-1/teams/team-1/members?api-version=7.1") {
        return jsonResponse({
          value: [
            {
              identity: {
                id: "abdel-team-identity-id",
                displayName: "Abdelrahman Elliithy",
                uniqueName: "abdelrahman@example.com",
                imageUrl: "https://example.com/abdel.png",
              },
            },
          ],
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const adapter = new AzureDevOpsRestAdapter({
      organizationUrl: "https://dev.azure.com/fabrikam",
      personalAccessToken: "pat",
    });

    const users = await adapter.fetchProjectUsers({ projectId: "project-1" });

    expect(users).toEqual([
      {
        id: "abdel-team-identity-id",
        displayName: "Abdelrahman Elliithy",
        uniqueName: "abdelrahman@example.com",
        imageUrl: "https://example.com/abdel.png",
      },
      {
        id: "mahmoud-origin-id",
        displayName: "Mahmoud ElSharkawy",
        uniqueName: "mahmoud@example.com",
      },
    ]);
  });

  it("falls back to project team members when Graph users are unavailable", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://vssps.dev.azure.com/fabrikam/_apis/graph/descriptors/project-1?api-version=7.1-preview.1") {
        return jsonResponse({ message: "Graph scope missing" }, { status: 403 });
      }
      if (url === "https://dev.azure.com/fabrikam/_apis/projects/project-1/teams?api-version=7.1") {
        return jsonResponse({ value: [{ id: "team-1", name: "Test Team" }] });
      }
      if (url === "https://dev.azure.com/fabrikam/_apis/projects/project-1/teams/team-1/members?api-version=7.1") {
        return jsonResponse({
          value: [
            {
              identity: {
                id: "abdel-team-identity-id",
                displayName: "Abdelrahman Elliithy",
                uniqueName: "abdelrahman@example.com",
              },
            },
          ],
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const adapter = new AzureDevOpsRestAdapter({
      organizationUrl: "https://dev.azure.com/fabrikam",
      personalAccessToken: "pat",
    });

    await expect(adapter.fetchProjectUsers({ projectId: "project-1" })).resolves.toEqual([
      {
        id: "abdel-team-identity-id",
        displayName: "Abdelrahman Elliithy",
        uniqueName: "abdelrahman@example.com",
      },
    ]);
  });
});

describe("AzureDevOpsRestAdapter Test Plans errors", () => {
  it("surfaces friendly license guidance instead of Azure exception JSON", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({
      $id: "1",
      message: "TF400409: You do not have licensing rights to access this feature: Web-based Test Execution",
      typeName: "Microsoft.TeamFoundation.Server.Core.MissingLicenseException",
      eventId: 3000,
    }, { status: 403 })) as typeof fetch;

    const adapter = new AzureDevOpsRestAdapter({
      organizationUrl: "https://dev.azure.com/fabrikam",
      personalAccessToken: "pat",
    });

    await expect(adapter.fetchTestPlans({ projectId: "project-1" })).rejects.toThrow(
      "Your Azure DevOps account isn’t licensed to use Test Plans. Ask an Azure DevOps administrator to assign Basic + Test Plans or Visual Studio Enterprise access, then try again.",
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
