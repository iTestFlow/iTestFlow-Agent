import type { Requirement, TestCase, TestCasePriority } from "./azure-devops-types";

type AzureWorkItem = {
  id: number;
  rev?: number;
  fields?: Record<string, unknown>;
  relations?: Array<{ rel?: string; url?: string; attributes?: Record<string, unknown> }>;
};

function text(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown) {
  return typeof value === "number" ? value : undefined;
}

function identityDisplayName(value: unknown) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "displayName" in value) {
    const displayName = (value as { displayName?: unknown }).displayName;
    return typeof displayName === "string" ? displayName : undefined;
  }
  return undefined;
}

function parseWorkItemIdFromUrl(url?: string) {
  return url?.match(/workItems\/(\d+)$/)?.[1];
}

export function mapAzureWorkItem(item: AzureWorkItem, azureProjectId: string): Requirement {
  const fields = item.fields ?? {};
  const relations = item.relations ?? [];

  return {
    id: String(item.id),
    revision: typeof item.rev === "number" ? item.rev : undefined,
    azureProjectId,
    teamProject: text(fields["System.TeamProject"]),
    workItemType: text(fields["System.WorkItemType"]) ?? "Unknown",
    title: text(fields["System.Title"]) ?? `Work Item ${item.id}`,
    description: text(fields["System.Description"]),
    acceptanceCriteria: text(fields["Microsoft.VSTS.Common.AcceptanceCriteria"]),
    state: text(fields["System.State"]),
    assignedTo: identityDisplayName(fields["System.AssignedTo"]),
    priority: numberValue(fields["Microsoft.VSTS.Common.Priority"]),
    severity: text(fields["Microsoft.VSTS.Common.Severity"]),
    tags: text(fields["System.Tags"])?.split(";").map((tag) => tag.trim()).filter(Boolean),
    areaPath: text(fields["System.AreaPath"]),
    iterationPath: text(fields["System.IterationPath"]),
    originalEstimate: numberValue(fields["Microsoft.VSTS.Scheduling.OriginalEstimate"]),
    remainingWork: numberValue(fields["Microsoft.VSTS.Scheduling.RemainingWork"]),
    completedWork: numberValue(fields["Microsoft.VSTS.Scheduling.CompletedWork"]),
    dueDate: text(fields["Microsoft.VSTS.Scheduling.DueDate"]),
    storyPoints: numberValue(fields["Microsoft.VSTS.Scheduling.StoryPoints"]),
    parentLinks: relations.filter((rel) => rel.rel?.includes("Hierarchy-Reverse")).map((rel) => parseWorkItemIdFromUrl(rel.url)).filter(Boolean) as string[],
    childLinks: relations.filter((rel) => rel.rel?.includes("Hierarchy-Forward")).map((rel) => parseWorkItemIdFromUrl(rel.url)).filter(Boolean) as string[],
    relatedLinks: relations.filter((rel) => rel.rel?.includes("Related")).map((rel) => parseWorkItemIdFromUrl(rel.url)).filter(Boolean) as string[],
    testedByLinks: relations.filter((rel) => rel.rel?.includes("TestedBy")).map((rel) => parseWorkItemIdFromUrl(rel.url)).filter(Boolean) as string[],
    testsLinks: relations.filter((rel) => rel.rel?.includes("Tests")).map((rel) => parseWorkItemIdFromUrl(rel.url)).filter(Boolean) as string[],
    createdDate: text(fields["System.CreatedDate"]),
    closedDate: text(fields["Microsoft.VSTS.Common.ClosedDate"]),
    updatedDate: text(fields["System.ChangedDate"]),
    raw: item,
  };
}

export function mapAzureTestCase(item: AzureWorkItem, azureProjectId: string): TestCase {
  const requirement = mapAzureWorkItem(item, azureProjectId);

  return {
    id: requirement.id,
    azureTestCaseId: requirement.id,
    title: requirement.title,
    description: requirement.description,
    preconditions: text(item.fields?.["Microsoft.VSTS.TCM.LocalDataSource"]),
    steps: parseAzureTestSteps(text(item.fields?.["Microsoft.VSTS.TCM.Steps"])),
    expectedResult: requirement.acceptanceCriteria,
    priority: toTestCasePriority(requirement.priority),
    testType: requirement.workItemType,
    tags: requirement.tags,
    raw: item,
  };
}

function toTestCasePriority(value?: number): TestCasePriority | undefined {
  return value === 1 || value === 2 || value === 3 || value === 4 ? value : undefined;
}

function parseAzureTestSteps(stepsXml?: string) {
  if (!stepsXml) return [];
  const steps = [...stepsXml.matchAll(/<step[^>]*>([\s\S]*?)<\/step>/gi)];

  return steps.map((step) => {
    const parameters = [...step[1].matchAll(/<parameterizedString[^>]*>([\s\S]*?)<\/parameterizedString>/gi)].map((match) =>
      decodeXml(stripHtml(match[1])),
    );
    return {
      action: parameters[0] ?? "",
      expectedResult: parameters[1] ?? "",
    };
  });
}

function stripHtml(value: string) {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function decodeXml(value: string) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
