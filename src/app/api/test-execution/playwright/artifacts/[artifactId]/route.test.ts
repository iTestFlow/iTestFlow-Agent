import { beforeEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";

const requireWorkflowContext = vi.fn();
const resolveProjectScope = vi.fn();
const getExecutionArtifact = vi.fn();
const getStream = vi.fn();

vi.mock("@/modules/credentials/scoped-resolution.service", () => ({ requireWorkflowContext: (...a: unknown[]) => requireWorkflowContext(...a), authErrorResponse: () => null }));
vi.mock("@/modules/projects/workspace-projects.service", () => ({ resolveProjectScope: (...a: unknown[]) => resolveProjectScope(...a) }));
vi.mock("@/modules/test-execution/execution-artifact.service", () => ({ getExecutionArtifact: (...a: unknown[]) => getExecutionArtifact(...a) }));
vi.mock("@/modules/documents/storage/local-filesystem-backend", () => ({ LocalFilesystemStorageBackend: class { getStream(...args: unknown[]) { return getStream(...args); } } }));

import { GET } from "./route";

beforeEach(() => {
  vi.resetAllMocks();
  requireWorkflowContext.mockResolvedValue({ workspace: { id: "w" } });
  resolveProjectScope.mockResolvedValue({ projectId: "p" });
  getExecutionArtifact.mockResolvedValue({ storage_key: "artifact", mime_type: "text/html", byte_size: 4 });
  getStream.mockResolvedValue(Readable.from("test"));
});

describe("execution artifact response", () => {
  it("forces active MCP content to download without same-origin execution", async () => {
    const url = "http://local/artifact?workspaceId=w&projectId=p&azureProjectId=ap&azureProjectName=P&azureOrganizationUrl=https%3A%2F%2Fdev.azure.com%2Fo";
    const response = await GET(new Request(url), { params: Promise.resolve({ artifactId: "a" }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toBe("sandbox");
  });
});
