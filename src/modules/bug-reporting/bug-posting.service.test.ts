import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/modules/audit/audit.service", () => ({
  writeAuditLog: vi.fn(),
}));

import { writeAuditLog } from "@/modules/audit/audit.service";
import type { AzureDevOpsAdapter } from "@/modules/integrations/azure-devops/azure-devops-adapter";
import type {
  AzureIteration,
  AzureWorkItemTypeField,
} from "@/modules/integrations/azure-devops/azure-devops-types";
import { fakeAzureAdapter, projectScope, requirement } from "@/test/factories";
import {
  type BugAttachmentInput,
  findCurrentIterationPath,
  normalizeCustomFieldsForAzure,
  postBugReportToAzureDevOps,
} from "./bug-posting.service";

function finalReport(overrides: Record<string, unknown> = {}) {
  return {
    title: "Checkout fails",
    precondition: "Cart contains an item",
    stepsToReproduce: "Submit payment",
    expectedResult: "Order is placed",
    actualResult: "An error appears",
    severity: "high",
    priority: "2",
    ...overrides,
  };
}

function attachment(fileName: string): BugAttachmentInput {
  return { fileName, contentType: "image/png", content: new ArrayBuffer(4) };
}

// Date-only string N local days from now; +/-1-day UTC skew stays inside the
// service's local-day window handling as long as offsets keep a 2-day margin.
function isoDate(offsetDays: number) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

const bugFieldMetadata: AzureWorkItemTypeField[] = [
  { name: "Bug Channel", referenceName: "Custom.BugChannel", type: "string" },
  { name: "Priority", referenceName: "Microsoft.VSTS.Common.Priority", type: "integer" },
];

// Happy-path adapter methods; individual tests override the branch under test.
function bugPostingFns() {
  return {
    fetchWorkItemTypeFields: vi.fn<AzureDevOpsAdapter["fetchWorkItemTypeFields"]>(async () => bugFieldMetadata),
    fetchIterations: vi.fn<AzureDevOpsAdapter["fetchIterations"]>(async () => []),
    createBug: vi.fn<AzureDevOpsAdapter["createBug"]>(async () => ({ success: true, azureBugId: "9001" })),
    buildWorkItemWebUrl: vi.fn<AzureDevOpsAdapter["buildWorkItemWebUrl"]>(
      () => "https://dev.azure.com/demo/Demo%20Project/_workitems/edit/9001",
    ),
  };
}

describe("normalizeCustomFieldsForAzure", () => {
  it("matches metadata by referenceName or display name case-insensitively and remaps to the canonical referenceName", () => {
    const metadata: AzureWorkItemTypeField[] = [
      { name: "Bug Channel", referenceName: "Custom.BugChannel", type: "string" },
    ];
    expect(normalizeCustomFieldsForAzure(
      [
        { referenceName: "custom.bugchannel", value: "Web" },
        { referenceName: "unmapped", name: "BUG CHANNEL", value: "Email" },
        // No metadata match: passed through under its own referenceName.
        { referenceName: "Custom.Unknown", value: "kept" },
      ],
      metadata,
    )).toEqual([
      { referenceName: "Custom.BugChannel", value: "Email" },
      { referenceName: "Custom.Unknown", value: "kept" },
    ]);
  });

  it("drops reserved and read-only bug fields, including ones reached via display-name remapping", () => {
    const metadata: AzureWorkItemTypeField[] = [
      { name: "Severity", referenceName: "Microsoft.VSTS.Common.Severity" },
      { name: "Priority", referenceName: "Microsoft.VSTS.Common.Priority" },
      { name: "Created By", referenceName: "System.CreatedBy", readOnly: true },
      { name: "Notes", referenceName: "Custom.Notes" },
    ];
    expect(normalizeCustomFieldsForAzure(
      [
        { referenceName: "System.Title", value: "hijack" },
        { referenceName: "System.State", value: "Closed" },
        { referenceName: "Microsoft.VSTS.TCM.ReproSteps", value: "<p>steps</p>" },
        { referenceName: "severity", value: "1 - Critical" },
        { referenceName: "priority", value: 1 },
        { referenceName: "System.AssignedTo", value: "someone" },
        { referenceName: "System.AreaPath", value: "Demo\\Other" },
        { referenceName: "System.IterationPath", value: "Demo\\Sprint 1" },
        { referenceName: "Microsoft.VSTS.Common.ValueArea", value: "Business" },
        { referenceName: "created by", value: "spoof" },
        { referenceName: "System.Watermark", value: 7 },
        { referenceName: "Custom.Notes", value: "keep" },
      ],
      metadata,
    )).toEqual([{ referenceName: "Custom.Notes", value: "keep" }]);
  });

  it("dedupes by canonical referenceName keeping the last value", () => {
    const metadata: AzureWorkItemTypeField[] = [
      { name: "Bug Channel", referenceName: "Custom.BugChannel" },
    ];
    expect(normalizeCustomFieldsForAzure(
      [
        { referenceName: "Custom.BugChannel", value: "Email" },
        { referenceName: "bug channel", value: "Web" },
      ],
      metadata,
    )).toEqual([{ referenceName: "Custom.BugChannel", value: "Web" }]);
  });

  it("coerces values from field metadata and drops values that cannot be represented", () => {
    const metadata: AzureWorkItemTypeField[] = [
      { name: "Points", referenceName: "Custom.Points", type: "integer" },
      { name: "Regression", referenceName: "Custom.Regression", type: "boolean" },
      { name: "Environment", referenceName: "Custom.Environment", type: "string", allowedValues: ["2. Testing/QC", "3. Staging"] },
      { name: "Empty", referenceName: "Custom.Empty", type: "integer" },
    ];
    expect(normalizeCustomFieldsForAzure(
      [
        { referenceName: "Custom.Points", value: "3.9" },
        { referenceName: "Custom.Regression", value: "Yes" },
        { referenceName: "Custom.Environment", value: "2. testing/qc" },
        // Blank numeric input has no representable value: dropped entirely.
        { referenceName: "Custom.Empty", value: "   " },
      ],
      metadata,
    )).toEqual([
      { referenceName: "Custom.Points", value: 3 },
      { referenceName: "Custom.Regression", value: true },
      { referenceName: "Custom.Environment", value: "2. Testing/QC" },
    ]);
  });
});

describe("findCurrentIterationPath", () => {
  const now = new Date(2026, 6, 6, 12, 0, 0);
  const iteration = (path: string, startDate?: string, finishDate?: string): AzureIteration => ({
    id: path, name: path, path, startDate, finishDate,
  });

  it("returns the iteration whose window contains now", () => {
    expect(findCurrentIterationPath([
      iteration("Demo\\Sprint 1", "2026-06-01", "2026-06-12"),
      iteration("Demo\\Sprint 2", "2026-07-01", "2026-07-12"),
      iteration("Demo\\Sprint 3", "2026-08-01", "2026-08-12"),
    ], now)).toBe("Demo\\Sprint 2");
  });

  it("falls back to the most recently started iteration when none is current", () => {
    expect(findCurrentIterationPath([
      iteration("Demo\\Sprint 1", "2026-06-01", "2026-06-10"),
      iteration("Demo\\Sprint 2", "2026-06-15", "2026-06-24"),
      iteration("Demo\\Future", "2026-08-01", "2026-08-12"),
      iteration("Demo\\Undated"),
    ], now)).toBe("Demo\\Sprint 2");
  });

  it("returns an empty string when no iteration has started", () => {
    expect(findCurrentIterationPath([
      iteration("Demo\\Future", "2026-08-01", "2026-08-12"),
      iteration("Demo\\Undated"),
    ], now)).toBe("");
    expect(findCurrentIterationPath([], now)).toBe("");
  });
});

describe("postBugReportToAzureDevOps", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates the bug from the validated report with normalized custom fields and audits success", async () => {
    const fns = bugPostingFns();
    const result = await postBugReportToAzureDevOps({
      adapter: fakeAzureAdapter(fns),
      scope: projectScope(),
      actor: "qa",
      report: finalReport({
        actualResult: "Error <500> appears\nSecond line",
        customFields: [
          { referenceName: "bug channel", value: "Web" },
          // Reserved via display-name remap: must never reach Azure as a raw field.
          { referenceName: "priority", value: 1 },
        ],
      }),
      // Blank parent ID is treated as absent: fetchWorkItemById is never called.
      parentStoryId: "   ",
      assignedTo: " qa@demo.com ",
      areaPath: " Demo\\Web ",
    });

    expect(fns.fetchWorkItemTypeFields).toHaveBeenCalledWith({ projectId: "azure-project-1", workItemType: "Bug" });
    expect(fns.createBug).toHaveBeenCalledWith({
      projectId: "azure-project-1",
      bug: expect.objectContaining({
        title: "Checkout fails",
        priority: 2,
        severity: "2 - High",
        assignedTo: "qa@demo.com",
        areaPath: "Demo\\Web",
        iterationPath: undefined,
        parentStoryId: undefined,
        customFields: [{ referenceName: "Custom.BugChannel", value: "Web" }],
      }),
    });
    // Repro steps are structured HTML with user text escaped and newlines preserved.
    expect(fns.createBug).toHaveBeenCalledWith(expect.objectContaining({
      bug: expect.objectContaining({
        reproStepsHtml: expect.stringContaining("<strong>Steps to Reproduce</strong><br/>Submit payment"),
      }),
    }));
    expect(fns.createBug).toHaveBeenCalledWith(expect.objectContaining({
      bug: expect.objectContaining({
        reproStepsHtml: expect.stringContaining("Error &lt;500&gt; appears<br/>Second line"),
      }),
    }));
    expect(fns.buildWorkItemWebUrl).toHaveBeenCalledWith({
      projectId: "azure-project-1",
      projectName: "Demo Project",
      workItemId: "9001",
    });
    expect(result).toEqual({
      bugId: "9001",
      webUrl: "https://dev.azure.com/demo/Demo%20Project/_workitems/edit/9001",
      attachmentResults: [],
    });
    expect(writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "project-1",
      azureProjectId: "azure-project-1",
      actor: "qa",
      action: "azure_devops.create_bug",
      status: "Success",
      entityId: "9001",
    }));
  });

  it("uses the requested iteration path without querying Azure iterations", async () => {
    const fns = bugPostingFns();
    await postBugReportToAzureDevOps({
      adapter: fakeAzureAdapter(fns),
      scope: projectScope(),
      actor: "qa",
      report: finalReport(),
      iterationPath: "  Demo\\Sprint 42  ",
    });
    expect(fns.fetchIterations).not.toHaveBeenCalled();
    expect(fns.createBug).toHaveBeenCalledWith(expect.objectContaining({
      bug: expect.objectContaining({ iterationPath: "Demo\\Sprint 42" }),
    }));
  });

  it("links the parent story and inherits its area and iteration paths", async () => {
    const fns = bugPostingFns();
    const fetchWorkItemById = vi.fn<AzureDevOpsAdapter["fetchWorkItemById"]>(async () =>
      requirement({ id: "101", areaPath: "Demo\\Team A", iterationPath: "Demo\\Sprint 9" }));
    await postBugReportToAzureDevOps({
      adapter: fakeAzureAdapter({ ...fns, fetchWorkItemById }),
      scope: projectScope(),
      actor: "qa",
      report: finalReport(),
      parentStoryId: " 101 ",
    });
    expect(fetchWorkItemById).toHaveBeenCalledWith({ projectId: "azure-project-1", workItemId: "101" });
    expect(fns.createBug).toHaveBeenCalledWith(expect.objectContaining({
      bug: expect.objectContaining({
        parentStoryId: "101",
        areaPath: "Demo\\Team A",
        iterationPath: "Demo\\Sprint 9",
      }),
    }));
  });

  it("prefers the current Azure iteration over the parent story's iteration path", async () => {
    const fns = bugPostingFns();
    fns.fetchIterations.mockResolvedValue([
      { id: "30", name: "Sprint 30", path: "Demo\\Sprint 30", startDate: isoDate(-5), finishDate: isoDate(5) },
    ]);
    const fetchWorkItemById = vi.fn<AzureDevOpsAdapter["fetchWorkItemById"]>(async () =>
      requirement({ id: "101", iterationPath: "Demo\\Sprint 9" }));
    await postBugReportToAzureDevOps({
      adapter: fakeAzureAdapter({ ...fns, fetchWorkItemById }),
      scope: projectScope(),
      actor: "qa",
      report: finalReport(),
      parentStoryId: "101",
    });
    expect(fns.createBug).toHaveBeenCalledWith(expect.objectContaining({
      bug: expect.objectContaining({ iterationPath: "Demo\\Sprint 30" }),
    }));
  });

  it("rejects a parent work item that is not a User Story before creating anything", async () => {
    const fns = bugPostingFns();
    const fetchWorkItemById = vi.fn<AzureDevOpsAdapter["fetchWorkItemById"]>(async () =>
      requirement({ id: "101", workItemType: "Feature" }));
    await expect(postBugReportToAzureDevOps({
      adapter: fakeAzureAdapter({ ...fns, fetchWorkItemById }),
      scope: projectScope(),
      actor: "qa",
      report: finalReport(),
      parentStoryId: "101",
    })).rejects.toThrow("Parent Story ID 101 is a Feature, not a User Story.");
    expect(fns.createBug).not.toHaveBeenCalled();
  });

  it("aggregates attachment successes and failures without aborting the batch", async () => {
    const fns = bugPostingFns();
    const uploadWorkItemAttachment = vi.fn<AzureDevOpsAdapter["uploadWorkItemAttachment"]>(async ({ attachment: file }) =>
      file.fileName === "broken-upload.png"
        ? { success: false, error: "upload rejected" }
        : { success: true, attachmentUrl: `https://ado/attachments/${file.fileName}` });
    const attachFileToWorkItem = vi.fn<AzureDevOpsAdapter["attachFileToWorkItem"]>(async ({ fileName }) =>
      fileName === "broken-link.png" ? { success: false, error: "link rejected" } : { success: true });

    const result = await postBugReportToAzureDevOps({
      adapter: fakeAzureAdapter({ ...fns, uploadWorkItemAttachment, attachFileToWorkItem }),
      scope: projectScope(),
      actor: "qa",
      report: finalReport(),
      attachments: [attachment("broken-upload.png"), attachment("broken-link.png"), attachment("ok.png")],
    });

    expect(result.attachmentResults).toEqual([
      { fileName: "broken-upload.png", success: false, error: "upload rejected" },
      { fileName: "broken-link.png", success: false, attachmentUrl: "https://ado/attachments/broken-link.png", error: "link rejected" },
      { fileName: "ok.png", success: true, attachmentUrl: "https://ado/attachments/ok.png" },
    ]);
    // Failed uploads are never linked; successful uploads are linked to the new bug.
    expect(attachFileToWorkItem).toHaveBeenCalledTimes(2);
    expect(attachFileToWorkItem).toHaveBeenCalledWith(expect.objectContaining({
      workItemId: "9001",
      fileName: "ok.png",
      attachmentUrl: "https://ado/attachments/ok.png",
    }));
    expect(writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      status: "Partial failure",
      message: expect.stringContaining("one or more attachments failed"),
    }));
  });

  it("throws and audits when Azure bug creation fails", async () => {
    const fns = bugPostingFns();
    fns.createBug.mockResolvedValue({ success: false, error: "PAT expired" });
    await expect(postBugReportToAzureDevOps({
      adapter: fakeAzureAdapter(fns),
      scope: projectScope(),
      actor: "qa",
      report: finalReport(),
    })).rejects.toThrow("PAT expired");
    expect(writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: "azure_devops.create_bug",
      status: "Failed",
      message: "Azure DevOps bug creation failed.",
    }));
    expect(fns.buildWorkItemWebUrl).not.toHaveBeenCalled();
  });

  it("falls back to a generic error when creation succeeds without a bug ID", async () => {
    const fns = bugPostingFns();
    fns.createBug.mockResolvedValue({ success: true });
    await expect(postBugReportToAzureDevOps({
      adapter: fakeAzureAdapter(fns),
      scope: projectScope(),
      actor: "qa",
      report: finalReport(),
    })).rejects.toThrow("Azure DevOps bug creation failed.");
  });

  it("rejects an invalid report before contacting Azure DevOps", async () => {
    const fns = bugPostingFns();
    await expect(postBugReportToAzureDevOps({
      adapter: fakeAzureAdapter(fns),
      scope: projectScope(),
      actor: "qa",
      report: { title: "Missing everything else" },
    })).rejects.toThrow();
    expect(fns.fetchWorkItemTypeFields).not.toHaveBeenCalled();
  });
});
