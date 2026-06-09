import "server-only";

import { writeAuditLog } from "@/modules/audit/audit.service";
import { parseExternalStructuredOutput } from "@/modules/llm/external-structured-output";
import type { LLMProvider } from "@/modules/llm/llm-types";
import { buildManualPromptMarkdown } from "@/modules/llm/manual-prompt";
import { buildBugReportSystemPrompt, bugReportPrompt } from "@/modules/llm/prompts";
import { assertProjectScope, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import type { Requirement } from "@/modules/integrations/azure-devops/azure-devops-types";
import {
  type BugAttachmentDescriptor,
  BugAttachmentDescriptorSchema,
  type BugCustomFieldValue,
  BugCustomFieldValueSchema,
  type BugRelatedTestCaseContext,
  GeneratedBugReportSchema,
} from "./schemas/bug-report.schema";

export async function generateBugReport(input: {
  scope: ProjectScope;
  provider: LLMProvider;
  bugDescription: string;
  parentStory?: Requirement | null;
  selectedRelatedTestCase?: BugRelatedTestCaseContext;
  customFields?: BugCustomFieldValue[];
  attachments?: BugAttachmentDescriptor[];
  projectKnowledgeBase?: unknown | null;
}) {
  const scope = assertProjectScope(input.scope);
  const promptDraft = buildBugReportPromptDraft(input);
  const result = await input.provider.generateStructuredOutput({
    schemaName: promptDraft.schemaName,
    schema: GeneratedBugReportSchema,
    system: promptDraft.systemPrompt,
    user: promptDraft.userPrompt,
    metadata: {
      action: "bug_report.generate",
      promptName: bugReportPrompt.name,
      promptVersion: bugReportPrompt.version,
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      azureProjectName: scope.azureProjectName,
      azureOrganizationUrl: scope.azureOrganizationUrl,
      targetWorkItemId: input.parentStory?.id,
    },
  });

  writeAuditLog({
    projectId: scope.projectId,
    azureProjectId: scope.azureProjectId,
    azureProjectName: scope.azureProjectName,
    azureOrganizationUrl: scope.azureOrganizationUrl,
    action: "bug_report.generate",
    status: "Success",
    message: "Generated a validated Azure DevOps bug report draft.",
    details: {
      provider: result.provider,
      model: result.model,
      promptVersion: bugReportPrompt.version,
      parentStoryId: input.parentStory?.id,
      attachmentCount: input.attachments?.length ?? 0,
    },
  });

  return result;
}

export function buildBugReportPromptDraft(input: {
  scope: ProjectScope;
  bugDescription: string;
  parentStory?: Requirement | null;
  selectedRelatedTestCase?: BugRelatedTestCaseContext;
  customFields?: BugCustomFieldValue[];
  attachments?: BugAttachmentDescriptor[];
  projectKnowledgeBase?: unknown | null;
}) {
  const scope = assertProjectScope(input.scope);
  const systemPrompt = buildBugReportSystemPrompt();
  const userPrompt = buildBugReportMarkdownPrompt({
    scope,
    bugDescription: input.bugDescription,
    parentStory: input.parentStory,
    selectedRelatedTestCase: input.selectedRelatedTestCase,
    customFields: normalizePromptCustomFields(input.customFields),
    attachments: normalizePromptAttachments(input.attachments),
    projectKnowledgeBase: input.projectKnowledgeBase,
  });

  return {
    schemaName: "BugReportGenerationOutput",
    promptName: bugReportPrompt.name,
    promptVersion: bugReportPrompt.version,
    systemPrompt,
    userPrompt,
    prompt: buildManualPromptMarkdown({
      title: "iTestFlow Bug Report Generation",
      system: systemPrompt,
      user: userPrompt,
    }),
  };
}

export function completeManualBugReport(input: {
  scope: ProjectScope;
  rawOutput: string;
  parentStoryId?: string;
}) {
  const scope = assertProjectScope(input.scope);
  const validatedOutput = parseExternalStructuredOutput({
    schemaName: "BugReportGenerationOutput",
    schema: GeneratedBugReportSchema,
    rawOutput: input.rawOutput,
  });

  writeAuditLog({
    projectId: scope.projectId,
    azureProjectId: scope.azureProjectId,
    azureProjectName: scope.azureProjectName,
    azureOrganizationUrl: scope.azureOrganizationUrl,
    action: "bug_report.manual_complete",
    status: "Success",
    message: "Generated a validated Azure DevOps bug report draft from external LLM output.",
    details: {
      provider: "external",
      model: "manual-external",
      promptVersion: bugReportPrompt.version,
      parentStoryId: input.parentStoryId,
    },
  });

  return {
    provider: "external",
    model: "manual-external",
    rawOutput: input.rawOutput,
    validatedOutput,
  };
}

function buildBugReportMarkdownPrompt(input: {
  scope: ProjectScope;
  bugDescription: string;
  parentStory?: Requirement | null;
  selectedRelatedTestCase?: BugRelatedTestCaseContext;
  customFields: BugCustomFieldValue[];
  attachments: BugAttachmentDescriptor[];
  projectKnowledgeBase?: unknown | null;
}) {
  return [
    "# Current Project",
    `- Azure Project ID: ${input.scope.azureProjectId}`,
    `- Azure Project Name: ${input.scope.azureProjectName}`,
    "",
    "# User Bug Description",
    input.bugDescription.trim(),
    "",
    "# Parent User Story Context",
    renderParentStory(input.parentStory),
    "",
    "# Selected Related Test Case Context",
    renderSelectedRelatedTestCase(input.selectedRelatedTestCase),
    "",
    "# User-Supplied Azure DevOps Fields",
    renderCustomFields(input.customFields),
    "",
    "# Attachments",
    renderAttachments(input.attachments),
    "",
    "# Saved Project Knowledge",
    renderProjectKnowledge(input.projectKnowledgeBase),
    "",
    "# Output Contract",
    "Respond with only one valid JSON object in this shape:",
    JSON.stringify(bugReportOutputContract, null, 2),
  ].join("\n");
}

function renderParentStory(story?: Requirement | null) {
  if (!story) return "No parent story was supplied.";
  return [
    `- ID: ${story.id}`,
    `- Work item type: ${story.workItemType}`,
    `- Title: ${story.title}`,
    story.description ? `- Description: ${stripHtml(story.description)}` : undefined,
    story.acceptanceCriteria ? `- Acceptance Criteria: ${stripHtml(story.acceptanceCriteria)}` : undefined,
    story.areaPath ? `- Area Path: ${story.areaPath}` : undefined,
    story.iterationPath ? `- Iteration Path: ${story.iterationPath}` : undefined,
  ].filter(Boolean).join("\n");
}

function renderSelectedRelatedTestCase(testCase?: BugRelatedTestCaseContext) {
  if (!testCase) return "No related test case was selected.";
  const id = testCase.azureTestCaseId ?? testCase.id;
  const lines = [
    "Use this selected story test case as grounding and inspiration for the bug reproduction steps, expected behavior, setup, and test data. Do not blindly copy the test case steps; adapt them to the user's reported defect and only include steps that help reproduce the bug.",
    "",
    id ? `- ID: ${id}` : undefined,
    `- Title: ${testCase.title}`,
    testCase.testType ? `- Type: ${testCase.testType}` : undefined,
    testCase.priority ? `- Priority: ${testCase.priority}` : undefined,
    testCase.description ? `- Description: ${stripHtml(testCase.description)}` : undefined,
    testCase.preconditions ? `- Preconditions: ${stripHtml(testCase.preconditions)}` : undefined,
    testCase.testData ? `- Test Data: ${stripHtml(testCase.testData)}` : undefined,
    testCase.expectedResult ? `- Overall Expected Result: ${stripHtml(testCase.expectedResult)}` : undefined,
    "",
    "Steps:",
    ...renderTestCaseSteps(testCase.steps),
  ];
  return lines.filter((line) => line !== undefined).join("\n");
}

function renderTestCaseSteps(steps: BugRelatedTestCaseContext["steps"]) {
  if (!steps.length) return ["No structured steps were supplied."];
  return steps.map((step, index) => {
    const action = step.action ? stripHtml(step.action) : "No action supplied";
    const expectedResult = step.expectedResult ? stripHtml(step.expectedResult) : "No expected result supplied";
    return `${index + 1}. Action: ${action}\n   Expected Result: ${expectedResult}`;
  });
}

function renderCustomFields(fields: BugCustomFieldValue[]) {
  if (!fields.length) return "No custom field values were supplied.";
  return fields
    .map((field) => `- ${field.name ? `${field.name} (${field.referenceName})` : field.referenceName}: ${String(field.value)}`)
    .join("\n");
}

function renderAttachments(attachments: BugAttachmentDescriptor[]) {
  if (!attachments.length) return "No attachments were supplied.";
  return attachments
    .map((attachment) => `- ${attachment.fileName}${attachment.contentType ? ` (${attachment.contentType})` : ""}`)
    .join("\n");
}

function renderProjectKnowledge(value: unknown) {
  if (!value) return "No saved project knowledge was supplied.";
  const serialized = JSON.stringify(value, null, 2);
  return serialized.length > 12000 ? `${serialized.slice(0, 12000)}\n[Truncated]` : serialized;
}

function normalizePromptCustomFields(fields?: BugCustomFieldValue[]) {
  return (fields ?? [])
    .map((field) => BugCustomFieldValueSchema.safeParse(field))
    .filter((result): result is { success: true; data: BugCustomFieldValue } => result.success)
    .map((result) => result.data);
}

function normalizePromptAttachments(attachments?: BugAttachmentDescriptor[]) {
  return (attachments ?? [])
    .map((attachment) => BugAttachmentDescriptorSchema.safeParse(attachment))
    .filter((result): result is { success: true; data: BugAttachmentDescriptor } => result.success)
    .map((result) => result.data);
}

function stripHtml(value: string) {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

const bugReportOutputContract = {
  title: "Clear, concise bug title (max 140 chars)",
  precondition: "Required setup, user role, data state, and dependencies",
  stepsToReproduce: "1. Navigate to...\n2. Click...\n3. Observe...",
  expectedResult: "What should happen according to the supplied requirement or expected behavior",
  actualResult: "What actually happens, including errors, incorrect data, or visual issues",
  systemInfo: "Browser, OS, device, app version, or 'Not specified'",
  severity: "1 - Critical|2 - High|3 - Medium|4 - Low; 3 - Medium is the default for incorrect/incomplete/inconsistent results without crashing",
  severityRationale: "One concise sentence explaining the severity suggestion",
  priority: "number only: 1|2|3|4; 1=Highest/cannot ship, 2=Medium/cannot ship but not emergency, 3=Low/optional, 4=Lowest/minor",
  priorityRationale: "One concise sentence explaining the priority suggestion",
  environment: "2. Testing/QC",
  category: "Functional",
  customFields: [{ referenceName: "Custom.Field", name: "Field Label", value: "string|number|boolean" }],
  contextUsed: ["source IDs only, such as parent-story-id or project-knowledge section IDs"],
};
