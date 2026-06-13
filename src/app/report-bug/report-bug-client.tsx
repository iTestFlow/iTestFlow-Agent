"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowLeft, Bug, CheckCircle2, ChevronDown, FileUp, ListChecks, Loader2, Play, Plus, Send, Trash2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { useUnsavedChangesGuard } from "@/components/navigation/unsaved-changes-provider";
import { Callout } from "@/components/qa/callout";
import { ProjectUserPicker } from "@/components/domain/project-user-picker";
import { GenerationModeToggle } from "@/components/workflow/generation-mode-toggle";
import {
  GeneratedTestCaseReviewCard,
  validateGeneratedTestCase,
} from "@/components/workflow/generated-test-cases-review";
import { AiGenerationProgress } from "@/components/workflow/ai-generation-progress";
import { ManualLLMPanel } from "@/components/workflow/manual-llm-panel";
import { SectionCard } from "@/components/workflow/test-intelligence-shared";
import { useAiGeneration } from "@/components/workflow/use-ai-generation";
import { WorkflowStepper } from "@/components/workflow/workflow-stepper";
import { WorkItemSummaryCard } from "@/components/workflow/work-item-summary-card";
import type { GeneratedTestCase } from "@/components/workflow/test-intelligence-types";
import { readActiveProject, type ActiveProjectScope } from "@/shared/lib/active-project";
import type { ProjectUser } from "@/types/azure-devops";

type WorkflowMode = "auto" | "manual";
type FieldValue = string | number | boolean;

type ApiState<T> = {
  loading: boolean;
  error: string | null;
  data: T | null;
};

type AzureClassificationPath = {
  id: string;
  name: string;
  path: string;
  startDate?: string;
  finishDate?: string;
};

type WorkItem = {
  id: string;
  workItemType: string;
  title: string;
  description?: string;
  acceptanceCriteria?: string;
  areaPath?: string;
  iterationPath?: string;
};

type BugFieldMetadata = {
  name: string;
  referenceName: string;
  type?: string;
  helpText?: string;
  required?: boolean;
  alwaysRequired?: boolean;
  readOnly?: boolean;
  defaultValue?: unknown;
  allowedValues?: FieldValue[];
};

type BugMetadataResponse = {
  fields: BugFieldMetadata[];
  users: ProjectUser[];
  iterations: AzureClassificationPath[];
  areas: AzureClassificationPath[];
  currentIterationPath?: string | null;
  defaultAreaPath?: string | null;
};

type BugCustomField = {
  referenceName: string;
  name?: string;
  value: FieldValue;
};

type CustomFieldRow = {
  id: string;
  referenceName: string;
  name?: string;
  value: string;
};

type BugReport = {
  title: string;
  precondition: string;
  stepsToReproduce: string;
  expectedResult: string;
  actualResult: string;
  systemInfo: string;
  severity: "1 - Critical" | "2 - High" | "3 - Medium" | "4 - Low";
  severityRationale?: string;
  priority: 1 | 2 | 3 | 4;
  priorityRationale?: string;
  environment?: string;
  category?: string;
  customFields?: BugCustomField[];
  contextUsed: string[];
};

type ManualPromptDraft = {
  prompt: string;
  promptVersion: string;
};

type PostBugResult = {
  bugId: string;
  webUrl: string;
  attachmentResults: Array<{ fileName: string; success: boolean; attachmentUrl?: string; error?: string }>;
};

type LinkedTestCase = {
  id: string;
  title: string;
  description?: string;
  preconditions?: string;
  steps: Array<{ action: string; expectedResult: string }>;
  testData?: string;
  expectedResult?: string;
  priority?: 1 | 2 | 3 | 4;
  testType?: string;
  automationSuitability?: string;
  azureTestCaseId?: string;
};

type ReproductionPublishResult = {
  mode: "existing" | "suggested";
  azureTestCaseId?: string;
  success: boolean;
  create?: { success: boolean; azureTestCaseId?: string; error?: string };
  storyLink?: { success: boolean; error?: string };
  bugLink?: { success: boolean; error?: string };
  error?: string;
};

async function postJson<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const text = await response.text();
  const json = parseJsonResponse(text, response.ok);
  if (!response.ok) throw new Error(json.error ?? `Request failed: ${response.status}`);
  return json as T;
}

function parseJsonResponse(text: string, ok: boolean) {
  try {
    return JSON.parse(text);
  } catch {
    if (ok) throw new Error("The server returned an invalid JSON response.");
    return { error: "The server returned a non-JSON response. Check the server logs or runtime configuration." };
  }
}

export function ReportBugClient() {
  const reviewSectionRef = useRef<HTMLDivElement | null>(null);
  const shouldScrollToReviewRef = useRef(false);
  const generationRequestVersionRef = useRef(0);
  const [activeStep, setActiveStep] = useState<"describe" | "review">("describe");
  const [scope, setScope] = useState<ActiveProjectScope | null>(null);
  const [mode, setMode] = useState<WorkflowMode>("auto");
  const [bugDescription, setBugDescription] = useState("");
  const [parentStoryId, setParentStoryId] = useState("");
  const [parentStory, setParentStory] = useState<WorkItem | null>(null);
  const [parentState, setParentState] = useState<ApiState<WorkItem>>({ loading: false, error: null, data: null });
  const [metadata, setMetadata] = useState<ApiState<BugMetadataResponse>>({ loading: false, error: null, data: null });
  const [assignedTo, setAssignedTo] = useState("");
  const [selectedAreaPath, setSelectedAreaPath] = useState("");
  const [selectedIterationPath, setSelectedIterationPath] = useState("");
  const [attachments, setAttachments] = useState<File[]>([]);
  const [customFieldRows, setCustomFieldRows] = useState<CustomFieldRow[]>([]);
  const gen = useAiGeneration();
  const prep = useAiGeneration({ prepareMs: 400, buildPromptMs: 500 });
  const resetGeneration = gen.reset;
  const resetPreparation = prep.reset;
  const [manualDraft, setManualDraft] = useState<ManualPromptDraft | null>(null);
  const [manualResponse, setManualResponse] = useState("");
  const [manualSubmitLoading, setManualSubmitLoading] = useState(false);
  const [manualSubmitError, setManualSubmitError] = useState<string | null>(null);
  const [report, setReport] = useState<BugReport | null>(null);
  const [postState, setPostState] = useState<ApiState<PostBugResult>>({ loading: false, error: null, data: null });
  const [linkedTestCases, setLinkedTestCases] = useState<ApiState<LinkedTestCase[]>>({ loading: false, error: null, data: null });
  const [selectedTestCaseId, setSelectedTestCaseId] = useState("");
  const [suggestTestCaseChecked, setSuggestTestCaseChecked] = useState(false);
  const [suggestedTestCase, setSuggestedTestCase] = useState<GeneratedTestCase | null>(null);
  const [testCasePublishState, setTestCasePublishState] = useState<ApiState<ReproductionPublishResult>>({ loading: false, error: null, data: null });
  const [hasUnfinishedWork, setHasUnfinishedWork] = useState(false);
  useUnsavedChangesGuard({
    dirty: hasUnfinishedWork,
    busy:
      gen.isRunning ||
      prep.isRunning ||
      manualSubmitLoading ||
      postState.loading ||
      testCasePublishState.loading,
  });

  const fields = useMemo(() => metadata.data?.fields ?? [], [metadata.data?.fields]);
  const users = useMemo(() => metadata.data?.users ?? [], [metadata.data?.users]);
  const areas = useMemo(() => metadata.data?.areas ?? [], [metadata.data?.areas]);
  const iterations = useMemo(() => metadata.data?.iterations ?? [], [metadata.data?.iterations]);
  const fieldOptionsId = "bug-custom-field-options";
  const parentStoryInvalid = Boolean(parentStory && parentStory.workItemType !== "User Story");
  const parentStoryValid = Boolean(parentStory && parentStory.workItemType === "User Story");
  const customFields = useMemo(() => rowsToCustomFields(customFieldRows, fields), [customFieldRows, fields]);

  useEffect(() => {
    setScope(readActiveProject());
    const onChange = (event: Event) => {
      const custom = event as CustomEvent<ActiveProjectScope>;
      generationRequestVersionRef.current += 1;
      resetGeneration();
      resetPreparation();
      setScope(custom.detail ?? readActiveProject());
      setActiveStep("describe");
      setParentStoryId("");
      setParentStory(null);
      setAssignedTo("");
      setSelectedAreaPath("");
      setSelectedIterationPath("");
      setAttachments([]);
      setCustomFieldRows([]);
      setManualDraft(null);
      setManualResponse("");
      setManualSubmitError(null);
      setReport(null);
      setPostState({ loading: false, error: null, data: null });
      resetTestCaseWorkflow();
      setHasUnfinishedWork(false);
    };
    window.addEventListener("itestflow:active-project-changed", onChange);
    return () => window.removeEventListener("itestflow:active-project-changed", onChange);
  }, [resetGeneration, resetPreparation]);

  useEffect(() => {
    if (!scope) {
      setMetadata({ loading: false, error: null, data: null });
      return;
    }
    let cancelled = false;
    setMetadata({ loading: true, error: null, data: null });
    void postJson<BugMetadataResponse>("/api/bugs/metadata", { scope })
      .then((data) => {
        if (cancelled) return;
        setMetadata({ loading: false, error: null, data });
        setSelectedIterationPath(data.currentIterationPath ?? "");
        setSelectedAreaPath(data.defaultAreaPath ?? "");
        setCustomFieldRows(buildRequiredFieldRows(data.fields));
      })
      .catch((error: unknown) => {
        if (!cancelled) setMetadata({ loading: false, error: error instanceof Error ? error.message : "Bug metadata fetch failed.", data: null });
      });
    return () => {
      cancelled = true;
    };
  }, [scope]);

  function changeParentStoryId(value: string) {
    invalidateGeneratedReport();
    setHasUnfinishedWork(true);
    setParentStoryId(value.replace(/\D/g, "").slice(0, 10));
    setParentStory(null);
    setParentState({ loading: false, error: null, data: null });
    resetManual();
    resetTestCaseWorkflow();
    setPostState({ loading: false, error: null, data: null });
  }

  function changeBugDescription(value: string) {
    invalidateGeneratedReport();
    setHasUnfinishedWork(true);
    setBugDescription(value);
    resetManual();
    setSuggestedTestCase(null);
    setTestCasePublishState({ loading: false, error: null, data: null });
  }

  function resetManual() {
    setManualDraft(null);
    setManualResponse("");
    setManualSubmitError(null);
  }

  function resetTestCaseWorkflow() {
    setLinkedTestCases({ loading: false, error: null, data: null });
    setSelectedTestCaseId("");
    setSuggestTestCaseChecked(false);
    setSuggestedTestCase(null);
    setTestCasePublishState({ loading: false, error: null, data: null });
  }

  function invalidateGeneratedReport() {
    generationRequestVersionRef.current += 1;
    gen.reset();
    prep.reset();
    resetManual();
    setActiveStep("describe");
    setReport(null);
    setPostState({ loading: false, error: null, data: null });
    setSuggestedTestCase(null);
    setTestCasePublishState({ loading: false, error: null, data: null });
  }

  const loadParentStory = useCallback(async () => {
    if (!scope || !parentStoryId.trim()) return;
    if (!/^\d+$/.test(parentStoryId.trim())) {
      setParentStory(null);
      setParentState({ loading: false, error: "Enter a valid numeric Parent Story ID.", data: null });
      return;
    }
    setParentState({ loading: true, error: null, data: null });
    try {
      const data = await postJson<{ workItem: WorkItem }>("/api/azure-devops/work-item-details", {
        scope,
        workItemId: parentStoryId.trim(),
      });
      setParentStory(data.workItem);
      if (data.workItem.areaPath) setSelectedAreaPath(data.workItem.areaPath);
      if (data.workItem.iterationPath) setSelectedIterationPath((current) => current || data.workItem.iterationPath || "");
      setParentState({ loading: false, error: null, data: data.workItem });
    } catch (error) {
      setParentStory(null);
      setParentState({ loading: false, error: error instanceof Error ? error.message : "Parent story fetch failed.", data: null });
    }
  }, [parentStoryId, scope]);

  useEffect(() => {
    if (!scope || !parentStoryId.trim()) return;
    const timeoutId = window.setTimeout(() => {
      void loadParentStory();
    }, 700);
    return () => window.clearTimeout(timeoutId);
  }, [loadParentStory, parentStoryId, scope]);

  useEffect(() => {
    if (!scope || !parentStoryValid || !parentStory?.id) {
      setLinkedTestCases({ loading: false, error: null, data: null });
      setSelectedTestCaseId("");
      setSuggestTestCaseChecked(false);
      setSuggestedTestCase(null);
      setTestCasePublishState({ loading: false, error: null, data: null });
      return;
    }

    let cancelled = false;
    setSelectedTestCaseId("");
    setSuggestedTestCase(null);
    setTestCasePublishState({ loading: false, error: null, data: null });
    setLinkedTestCases({ loading: true, error: null, data: null });
    void postJson<{ linkedTestCases: LinkedTestCase[] }>("/api/azure-devops/linked-test-cases", {
      scope,
      userStoryId: parentStory.id,
    })
      .then((data) => {
        if (!cancelled) setLinkedTestCases({ loading: false, error: null, data: data.linkedTestCases });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLinkedTestCases({
            loading: false,
            error: error instanceof Error ? error.message : "Linked test case fetch failed.",
            data: null,
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [parentStory?.id, parentStoryValid, scope]);

  useEffect(() => {
    if (!report || !shouldScrollToReviewRef.current) return;
    shouldScrollToReviewRef.current = false;
    reviewSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [report]);

  async function generate() {
    if (!scope || !bugDescription.trim() || parentStoryInvalid) return;
    if (gen.isRunning) return;
    invalidateGeneratedReport();
    setPostState({ loading: false, error: null, data: null });
    const data = await gen.start((signal) =>
      postJson<BugReport>("/api/bugs/generate", buildGenerationPayload(scope), signal),
    );
    if (data) {
      applyGeneratedReport(data);
    }
  }

  async function prepareManualPrompt() {
    if (!scope || !bugDescription.trim() || parentStoryInvalid) return;
    if (prep.isRunning) return;
    invalidateGeneratedReport();
    setManualSubmitError(null);
    setManualResponse("");
    const data = await prep.start((signal) =>
      postJson<ManualPromptDraft>("/api/bugs/manual/draft", buildGenerationPayload(scope), signal),
    );
    if (data) setManualDraft(data);
  }

  async function submitManualResponse() {
    if (!scope || !manualResponse.trim()) return;
    const requestVersion = generationRequestVersionRef.current;
    setManualSubmitLoading(true);
    setManualSubmitError(null);
    try {
      const data = await postJson<BugReport>("/api/bugs/manual/submit", {
        scope,
        parentStoryId: parentStoryId.trim() || undefined,
        rawOutput: manualResponse,
      });
      if (requestVersion !== generationRequestVersionRef.current) return;
      applyGeneratedReport(data);
    } catch (error) {
      if (requestVersion !== generationRequestVersionRef.current) return;
      setManualSubmitError(error instanceof Error ? error.message : "External LLM response validation failed.");
    } finally {
      setManualSubmitLoading(false);
    }
  }

  function buildGenerationPayload(activeScope: ActiveProjectScope) {
    const selectedRelatedTestCase = buildSelectedRelatedTestCaseContext();
    return {
      scope: activeScope,
      bugDescription,
      parentStoryId: parentStoryId.trim() || undefined,
      selectedRelatedTestCase,
      customFields,
      attachments: attachments.map((file) => ({ fileName: file.name, contentType: file.type || undefined, size: file.size })),
    };
  }

  function buildSelectedRelatedTestCaseContext() {
    if (!selectedTestCaseId) return undefined;
    const selected = linkedTestCases.data?.find((testCase) => testCaseId(testCase) === selectedTestCaseId);
    if (!selected) return undefined;
    return {
      id: selected.id,
      azureTestCaseId: selected.azureTestCaseId,
      title: selected.title,
      description: selected.description,
      preconditions: selected.preconditions,
      steps: (selected.steps ?? []).map((step) => ({
        action: step.action,
        expectedResult: step.expectedResult,
      })),
      testData: selected.testData,
      expectedResult: selected.expectedResult,
      priority: selected.priority,
      testType: selected.testType,
    };
  }

  function applyGeneratedReport(data: BugReport) {
    setActiveStep("review");
    setHasUnfinishedWork(true);
    const mergedCustomFields = mergeCustomFields(customFields, data.customFields ?? []);
    const nextReport = { ...data, customFields: mergedCustomFields };
    shouldScrollToReviewRef.current = true;
    setReport(nextReport);
    setCustomFieldRows(customFieldsToRows(mergedCustomFields, fields));
    setSuggestedTestCase(suggestTestCaseChecked ? buildSuggestedTestCaseFromBugReport(nextReport, bugDescription) : null);
    setTestCasePublishState({ loading: false, error: null, data: null });
  }

  function updateReport<K extends keyof BugReport>(key: K, value: BugReport[K]) {
    setHasUnfinishedWork(true);
    setReport((current) => (current ? { ...current, [key]: value } : current));
    setPostState({ loading: false, error: null, data: null });
  }

  function updateCustomFieldRow(rowId: string, patch: Partial<CustomFieldRow>) {
    invalidateGeneratedReport();
    setHasUnfinishedWork(true);
    setCustomFieldRows((current) =>
      current.map((row) => {
        if (row.id !== rowId) return row;
        const next = { ...row, ...patch };
        const metadataField = findField(fields, next.referenceName);
        if (!metadataField) return next;
        return {
          ...next,
          name: metadataField.name,
          referenceName: metadataField.referenceName,
          value: patch.referenceName !== undefined ? defaultFieldValue(metadataField) : next.value,
        };
      }),
    );
    setPostState({ loading: false, error: null, data: null });
  }

  function addCustomFieldRow() {
    invalidateGeneratedReport();
    setHasUnfinishedWork(true);
    setCustomFieldRows((current) => [...current, { id: createLocalId("field"), referenceName: "", value: "" }]);
  }

  function removeCustomFieldRow(rowId: string) {
    invalidateGeneratedReport();
    setHasUnfinishedWork(true);
    setCustomFieldRows((current) => current.filter((row) => row.id !== rowId));
  }

  function selectRelatedTestCase(testCaseId: string) {
    invalidateGeneratedReport();
    setHasUnfinishedWork(true);
    setSelectedTestCaseId(testCaseId);
    if (testCaseId) {
      setSuggestTestCaseChecked(false);
      setSuggestedTestCase(null);
    }
    setTestCasePublishState({ loading: false, error: null, data: null });
  }

  function changeSuggestTestCaseChecked(checked: boolean) {
    invalidateGeneratedReport();
    setHasUnfinishedWork(true);
    setSuggestTestCaseChecked(checked);
    setTestCasePublishState({ loading: false, error: null, data: null });
    setSuggestedTestCase(null);
  }

  function updateSuggestedTestCase(patch: Partial<GeneratedTestCase>) {
    setHasUnfinishedWork(true);
    setSuggestedTestCase((current) => (current ? { ...current, ...patch } : current));
    setTestCasePublishState({ loading: false, error: null, data: null });
  }

  async function publishReproductionTestCase() {
    if (!scope || !parentStoryValid || !parentStory?.id || !postState.data || testCasePublishState.loading) return;
    if (selectedTestCaseId || !suggestedTestCase) return;

    setTestCasePublishState({ loading: true, error: null, data: null });
    try {
      const data = await postJson<ReproductionPublishResult>("/api/bugs/reproduction-test-case/publish", {
        scope,
        parentStoryId: parentStory.id,
        bugId: postState.data.bugId,
        suggestedTestCase,
      });
      setTestCasePublishState({ loading: false, error: null, data });
      const attachmentsComplete = postState.data?.attachmentResults.every((attachment) => attachment.success) ?? false;
      if (data.success && attachmentsComplete) setHasUnfinishedWork(false);
    } catch (error) {
      setTestCasePublishState({
        loading: false,
        error: error instanceof Error ? error.message : "Reproduction test case publish failed.",
        data: null,
      });
    }
  }

  async function postBug() {
    if (!scope || !report || parentStoryInvalid) return;
    setPostState({ loading: true, error: null, data: null });
    setTestCasePublishState({ loading: false, error: null, data: null });
    try {
      const formData = new FormData();
      formData.append(
        "payload",
        JSON.stringify({
          scope,
          parentStoryId: parentStoryId.trim() || undefined,
          assignedTo: assignedTo || undefined,
          areaPath: selectedAreaPath || undefined,
          iterationPath: selectedIterationPath || undefined,
          report: { ...report, customFields },
        }),
      );
      attachments.forEach((file) => formData.append("attachments", file));
      const response = await fetch("/api/bugs/post", { method: "POST", body: formData });
      const text = await response.text();
      const json = parseJsonResponse(text, response.ok);
      if (!response.ok) throw new Error(json.error ?? `Request failed: ${response.status}`);
      const result = json as PostBugResult;
      setPostState({ loading: false, error: null, data: result });
      const attachmentsComplete = result.attachmentResults.every((attachment) => attachment.success);
      const reproductionPublishPending = suggestTestCaseChecked && Boolean(suggestedTestCase);
      if (attachmentsComplete && !reproductionPublishPending) setHasUnfinishedWork(false);
    } catch (error) {
      setPostState({ loading: false, error: error instanceof Error ? error.message : "Azure DevOps bug creation failed.", data: null });
    }
  }

  const generateDisabled =
    !scope ||
    !bugDescription.trim() ||
    metadata.loading ||
    gen.isRunning ||
    prep.isRunning ||
    parentStoryInvalid;
  const postDisabled = !scope || !report || !report.title.trim() || !report.actualResult.trim() || !report.stepsToReproduce.trim() || postState.loading || parentStoryInvalid;
  const publishTestCaseDisabled =
    !scope ||
    !parentStoryValid ||
    !postState.data ||
    testCasePublishState.loading ||
    !suggestedTestCase ||
    !validateGeneratedTestCase(suggestedTestCase).valid;

  return (
    <div className="space-y-5">
      {!scope ? <WarningBlock message="Please select an Azure DevOps project before creating a bug." /> : null}
      <WorkflowStepper
        steps={[
          {
            id: "describe",
            label: "Describe & Generate Bug",
            description: "Capture the defect, context, Azure fields, and evidence.",
            icon: Bug,
          },
          {
            id: "review",
            label: "Review & Post Bug",
            description: "Refine the generated report and publish it to Azure DevOps.",
            icon: ListChecks,
          },
        ]}
        activeStepId={activeStep}
        completedStepIds={report ? ["describe"] : []}
        enabledStepIds={report ? ["describe", "review"] : ["describe"]}
        onStepChange={setActiveStep}
        ariaLabel="Report Bug workflow"
      />

      {activeStep === "describe" ? (
        <div className="space-y-5">
          <SectionCard
            title="Describe Bug"
            description="Capture the defect, parent story, Azure fields, assignee, and evidence."
            action={
              <GenerationModeToggle
                mode={mode}
                onChange={(nextMode) => {
                  if (nextMode === mode) return;
                  setHasUnfinishedWork(true);
                  invalidateGeneratedReport();
                  setMode(nextMode);
                }}
              />
            }
          >
            <div className="space-y-5 p-4">
              {metadata.error ? <ErrorBlock message={metadata.error} /> : null}
              <Field label="Bug description">
                <Textarea
                  value={bugDescription}
                  onChange={(event) => changeBugDescription(event.target.value)}
                  className="min-h-32"
                  placeholder="Describe what went wrong, where it happened, and what you expected instead."
                />
              </Field>

              <div className="grid items-end gap-4 lg:grid-cols-[minmax(260px,360px)_auto]">
                <Field label="Parent Story ID">
                  <Input
                    value={parentStoryId}
                    onChange={(event) => changeParentStoryId(event.target.value)}
                    inputMode="numeric"
                    maxLength={10}
                    placeholder="e.g. 123456"
                  />
                </Field>
                {mode === "auto" ? (
                  <Button type="button" onClick={generate} disabled={generateDisabled}>
                    <Play className="size-4" />
                    {gen.isRunning ? "Generating..." : "Generate"}
                  </Button>
                ) : (
                  <Button type="button" onClick={prepareManualPrompt} disabled={generateDisabled}>
                    <Play className="size-4" />
                    {prep.isRunning ? "Preparing..." : "Prepare Prompt"}
                  </Button>
                )}
              </div>

              <WorkItemSummaryCard
                story={parentStory}
                loading={parentState.loading}
                error={parentState.error}
                valid={parentStory?.workItemType === "User Story"}
                invalidNote="Parent link requires a User Story."
                loadingText="Loading parent story..."
              />

              <RelatedTestCasePanel
                parentStory={parentStory}
                linkedTestCases={linkedTestCases}
                selectedTestCaseId={selectedTestCaseId}
                suggestTestCaseChecked={suggestTestCaseChecked}
                onSelectTestCase={selectRelatedTestCase}
                onSuggestTestCaseChange={changeSuggestTestCaseChecked}
              />

              <div className="grid gap-4 lg:grid-cols-2">
                <Field label="Assignee">
                  <ProjectUserPicker
                    mode="single"
                    value={assignedTo}
                    users={users}
                    loading={metadata.loading}
                    disabled={!scope}
                    onValueChange={(value) => {
                      setHasUnfinishedWork(true);
                      setAssignedTo(value);
                    }}
                    placeholder="Unassigned"
                    emptyOptionLabel="Unassigned"
                    clearable
                    ariaLabel="Assignee"
                  />
                </Field>
                <Field label="Area path">
                  <select
                    value={selectedAreaPath}
                    onChange={(event) => {
                      setHasUnfinishedWork(true);
                      setSelectedAreaPath(event.target.value);
                    }}
                    className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                    disabled={metadata.loading}
                  >
                    <option value="">{metadata.loading ? "Loading areas..." : "Azure DevOps default"}</option>
                    {areas.map((area) => (
                      <option key={area.id} value={area.path}>
                        {area.path}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Iteration path">
                  <select
                    value={selectedIterationPath}
                    onChange={(event) => {
                      setHasUnfinishedWork(true);
                      setSelectedIterationPath(event.target.value);
                    }}
                    className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                    disabled={metadata.loading}
                  >
                    <option value="">{metadata.loading ? "Loading iterations..." : "Azure DevOps default"}</option>
                    {iterations.map((iteration) => (
                      <option key={iteration.id} value={iteration.path}>
                        {iteration.path}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>

              <Field label="Attachments">
                <div className="rounded-md border border-dashed border-input bg-muted/20 p-4">
                  <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm font-medium hover:bg-muted">
                    <FileUp className="size-4" />
                    Select files
                    <input
                      type="file"
                      multiple
                      accept="image/*,video/*,.gif"
                      className="sr-only"
                      onChange={(event) => {
                        invalidateGeneratedReport();
                        setHasUnfinishedWork(true);
                        setAttachments(Array.from(event.target.files ?? []));
                      }}
                    />
                  </label>
                  {attachments.length ? (
                    <div className="mt-3 grid gap-2">
                      {attachments.map((file) => (
                        <div key={`${file.name}-${file.size}`} className="flex items-center justify-between gap-3 rounded-md bg-background px-3 py-2 text-sm">
                          <span className="min-w-0 truncate">{file.name}</span>
                          <span className="shrink-0 text-xs text-muted-foreground">{formatFileSize(file.size)}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-2 text-xs text-muted-foreground">No files selected.</p>
                  )}
                </div>
              </Field>

              <CustomFieldsEditor
                rows={customFieldRows}
                fields={fields}
                datalistId={fieldOptionsId}
                onAdd={addCustomFieldRow}
                onRemove={removeCustomFieldRow}
                onChange={updateCustomFieldRow}
              />
            </div>
          </SectionCard>

          {mode === "manual" && prep.status !== "idle" && prep.status !== "completed" ? (
            <AiGenerationProgress
              mode="prep"
              variant="generic"
              status={prep.status}
              elapsedSeconds={prep.elapsedSeconds}
              errorMessage={prep.errorMessage}
              canCancel
              onCancel={prep.cancel}
              onRetry={() => {
                prep.retry();
                void prepareManualPrompt();
              }}
            />
          ) : null}

          {mode === "manual" ? (
            <div className="space-y-4">
              {manualSubmitError ? <Callout tone="error">{manualSubmitError}</Callout> : null}
              {manualDraft ? (
                <ManualLLMPanel
                  prompt={manualDraft.prompt}
                  promptVersion={manualDraft.promptVersion}
                  response={manualResponse}
                  onResponseChange={(value) => {
                    setHasUnfinishedWork(true);
                    setManualResponse(value);
                  }}
                  onSubmit={submitManualResponse}
                  submitting={manualSubmitLoading}
                  submitLabel="Validate and Continue"
                  submittingLabel="Validating..."
                  responseLabel="External LLM response"
                  responsePlaceholder="Paste the JSON response here."
                  promptMinHeightClass="min-h-[320px]"
                  responseMinHeightClass="min-h-[240px]"
                />
              ) : null}
            </div>
          ) : null}

          {gen.status !== "idle" && gen.status !== "completed" ? (
            <AiGenerationProgress
              variant="generic"
              status={gen.status}
              elapsedSeconds={gen.elapsedSeconds}
              errorMessage={gen.errorMessage}
              canCancel
              onCancel={gen.cancel}
              onRetry={() => {
                gen.retry();
                void generate();
              }}
            />
          ) : null}
        </div>
      ) : report ? (
        <div ref={reviewSectionRef} className="space-y-5">
          <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-sm font-semibold text-foreground">
                {parentStoryId ? `Reviewing bug for story #${parentStoryId}` : "Reviewing generated bug report"}
                {parentStory?.title ? (
                  <span className="font-normal text-muted-foreground"> - {parentStory.title}</span>
                ) : null}
              </div>
              <div className="text-xs text-muted-foreground">The generated report stays available while you revisit the source details.</div>
            </div>
            <Button type="button" variant="outline" onClick={() => setActiveStep("describe")}>
              <ArrowLeft className="size-4" />
              Back to inputs
            </Button>
          </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Review & Post</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5 pt-5">
            <Field label="Title">
              <Input value={report.title} onChange={(event) => updateReport("title", event.target.value)} />
            </Field>

            <div className="grid gap-3 lg:grid-cols-2">
              <SuggestionSelect
                label="Priority"
                rationale={report.priorityRationale}
                value={String(report.priority)}
                onChange={(value) => updateReport("priority", Number(value) as BugReport["priority"])}
                options={[
                  { value: "1", label: "1 - Highest", hint: "Cannot ship" },
                  { value: "2", label: "2 - Medium", hint: "Ship blocker" },
                  { value: "3", label: "3 - Low", hint: "Optional" },
                  { value: "4", label: "4 - Lowest", hint: "Minor" },
                ]}
              />
              <SuggestionSelect
                label="Severity"
                rationale={report.severityRationale}
                value={report.severity}
                onChange={(value) => updateReport("severity", value as BugReport["severity"])}
                options={[
                  { value: "1 - Critical", label: "1 - Critical", hint: "No workaround" },
                  { value: "2 - High", label: "2 - High", hint: "Workaround exists" },
                  { value: "3 - Medium", label: "3 - Medium", hint: "Default" },
                  { value: "4 - Low", label: "4 - Low", hint: "Minor/cosmetic" },
                ]}
              />
            </div>

            <Field label="Precondition">
              <Textarea value={report.precondition} onChange={(event) => updateReport("precondition", event.target.value)} />
            </Field>
            <Field label="Steps to Reproduce">
              <Textarea className="min-h-36" value={report.stepsToReproduce} onChange={(event) => updateReport("stepsToReproduce", event.target.value)} />
            </Field>
            <div className="grid gap-4 lg:grid-cols-2">
              <Field label="Expected Result">
                <Textarea value={report.expectedResult} onChange={(event) => updateReport("expectedResult", event.target.value)} />
              </Field>
              <Field label="Actual Result">
                <Textarea value={report.actualResult} onChange={(event) => updateReport("actualResult", event.target.value)} />
              </Field>
            </div>

            <CustomFieldsSummary customFields={customFields} />

            {postState.error ? <ErrorBlock message={postState.error} /> : null}
            {postState.data ? <PostSuccess result={postState.data} /> : null}

            <div className="flex justify-end">
              <Button type="button" onClick={postBug} disabled={postDisabled}>
                {postState.loading ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                {postState.loading ? "Posting..." : "Post to Azure DevOps"}
              </Button>
            </div>

            {suggestedTestCase && !selectedTestCaseId ? (
              <SuggestedReproductionTestCasePanel
                testCase={suggestedTestCase}
                publishState={testCasePublishState}
                bugId={postState.data?.bugId}
                publishDisabled={publishTestCaseDisabled}
                onChange={updateSuggestedTestCase}
                onPublish={publishReproductionTestCase}
              />
            ) : null}
          </CardContent>
        </Card>
        </div>
      ) : null}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid content-start gap-2">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function SuggestionSelect({
  label,
  rationale,
  value,
  options,
  onChange,
}: {
  label: string;
  rationale?: string;
  value: string;
  options: Array<{ value: string; label: string; hint: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <div className="rounded-md border border-input bg-background p-3">
      <div className="grid gap-3 md:grid-cols-[120px_minmax(180px,240px)_minmax(0,1fr)] md:items-start">
        <div className="flex min-h-10 flex-wrap items-center gap-2">
          <Label>{label}</Label>
          <Badge variant="secondary" className="shrink-0">LLM</Badge>
        </div>
        <select
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label} - {option.hint}
            </option>
          ))}
        </select>
        <p className="text-xs leading-5 text-muted-foreground">
          {rationale || "No rationale provided."}
        </p>
      </div>
    </div>
  );
}

function RelatedTestCasePanel({
  parentStory,
  linkedTestCases,
  selectedTestCaseId,
  suggestTestCaseChecked,
  onSelectTestCase,
  onSuggestTestCaseChange,
}: {
  parentStory: WorkItem | null;
  linkedTestCases: ApiState<LinkedTestCase[]>;
  selectedTestCaseId: string;
  suggestTestCaseChecked: boolean;
  onSelectTestCase: (testCaseId: string) => void;
  onSuggestTestCaseChange: (checked: boolean) => void;
}) {
  const storyReady = parentStory?.workItemType === "User Story";
  const cases = linkedTestCases.data ?? [];
  const selectedCase = cases.find((testCase) => testCaseId(testCase) === selectedTestCaseId);

  return (
    <div className="grid gap-4 rounded-md border border-input bg-muted/10 p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Label>Related test case</Label>
            <Badge variant="secondary">Optional</Badge>
          </div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Select an existing story test case, or review the generated reproduction test case after the bug draft is created.
          </p>
        </div>
        {storyReady ? <Badge variant="outline">Story #{parentStory.id}</Badge> : null}
      </div>

      {!storyReady ? <InfoBlock message="Load a valid parent User Story to fetch related test cases." /> : null}
      {linkedTestCases.error ? <ErrorBlock message={linkedTestCases.error} /> : null}

      <TestCasePicker
        value={selectedTestCaseId}
        testCases={cases}
        loading={linkedTestCases.loading}
        disabled={!storyReady}
        onChange={onSelectTestCase}
      />

      {selectedCase ? <SelectedTestCasePreview testCase={selectedCase} /> : null}

      {!selectedTestCaseId ? (
        <label className={`flex items-start gap-3 rounded-md border border-input bg-background p-3 text-sm ${storyReady ? "" : "opacity-60"}`}>
          <Checkbox
            checked={suggestTestCaseChecked}
            disabled={!storyReady}
            onCheckedChange={(checked) => onSuggestTestCaseChange(checked === true)}
            className="mt-0.5"
          />
          <span className="grid gap-1">
            <span className="font-medium">Suggest test case</span>
            <span className="text-xs leading-5 text-muted-foreground">
              Build an editable reproduction test case after the bug draft is generated.
            </span>
          </span>
        </label>
      ) : null}
    </div>
  );
}

function TestCasePicker({
  value,
  testCases,
  loading,
  disabled,
  onChange,
}: {
  value: string;
  testCases: LinkedTestCase[];
  loading: boolean;
  disabled: boolean;
  onChange: (testCaseId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = testCases.find((testCase) => testCaseId(testCase) === value);
  const label = loading ? "Loading linked test cases..." : selected ? `#${testCaseId(selected)} - ${selected.title}` : "No related test case selected";

  function selectTestCase(testCase: LinkedTestCase) {
    onChange(testCaseId(testCase));
    setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <div className="flex gap-2">
        <PopoverTrigger asChild>
          <Button type="button" variant="outline" disabled={disabled || loading} className="h-10 min-w-0 flex-1 justify-between px-3">
            <span className="inline-flex min-w-0 items-center gap-2">
              {loading ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
              <span className="truncate">{label}</span>
            </span>
            <ChevronDown className={`size-4 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
          </Button>
        </PopoverTrigger>
        {value ? (
          <Button type="button" variant="ghost" size="icon" onClick={() => onChange("")} aria-label="Clear related test case">
            <X className="size-4" />
          </Button>
        ) : null}
      </div>
      <PopoverContent align="start" className="w-[520px] max-w-[calc(100vw-2rem)] p-0">
        <Command>
          <CommandInput placeholder="Search linked test cases" />
          <CommandList>
            <CommandEmpty>No linked test cases found.</CommandEmpty>
            <CommandGroup>
              {testCases.map((testCase) => {
                const id = testCaseId(testCase);
                return (
                  <CommandItem
                    key={id}
                    value={`${id} ${testCase.title}`}
                    data-checked={value === id}
                    onSelect={() => selectTestCase(testCase)}
                    className="items-start gap-3 py-2"
                  >
                    <span className="mt-0.5 font-mono text-xs text-primary">#{id}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{testCase.title}</span>
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {testCase.steps?.length ?? 0} steps{testCase.priority ? ` - Priority ${testCase.priority}` : ""}
                      </span>
                    </span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function SelectedTestCasePreview({ testCase }: { testCase: LinkedTestCase }) {
  return (
    <div className="grid gap-2 rounded-md border border-success/30 bg-success/10 p-3 text-sm text-foreground">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs font-semibold">#{testCaseId(testCase)}</span>
        <Badge variant="secondary">{testCase.testType ?? "Test Case"}</Badge>
        {testCase.priority ? <Badge variant="outline">Priority {testCase.priority}</Badge> : null}
      </div>
      <div className="font-medium">{testCase.title}</div>
      <div className="text-xs text-success">
        This existing story test case is selected as the related reproduction case.
      </div>
    </div>
  );
}

function SuggestedReproductionTestCasePanel({
  testCase,
  publishState,
  bugId,
  publishDisabled,
  onChange,
  onPublish,
}: {
  testCase: GeneratedTestCase;
  publishState: ApiState<ReproductionPublishResult>;
  bugId?: string;
  publishDisabled: boolean;
  onChange: (patch: Partial<GeneratedTestCase>) => void;
  onPublish: () => void;
}) {
  return (
    <GeneratedTestCaseReviewCard
      testCase={testCase}
      onChange={(next) => onChange(next)}
      heading="Suggested Reproduction Test Case"
      helperText="Generated after reviewing the bug draft. Review and edit it before creating and linking it to the posted bug."
      editLabel="Review & Edit"
      footer={
        <div className="grid gap-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-sm leading-6 text-muted-foreground">
              {bugId
                ? `Bug ${bugId} is ready for the test case creation and linking action.`
                : "Post the bug first, then create and link this generated reproduction test case."}
            </div>
            <Button type="button" onClick={onPublish} disabled={publishDisabled}>
              {publishState.loading ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
              {publishState.loading ? "Linking..." : "Create / link test case"}
            </Button>
          </div>
          {publishState.error ? <ErrorBlock message={publishState.error} /> : null}
          {publishState.data ? <ReproductionPublishSummary result={publishState.data} /> : null}
        </div>
      }
    />
  );
}

function ReproductionPublishSummary({ result }: { result: ReproductionPublishResult }) {
  return (
    <div className={`rounded-md border p-3 text-sm ${result.success ? "border-success/30 bg-success/10 text-foreground" : "border-warning/40 bg-warning/15 text-foreground"}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-semibold">
          {result.success ? "Reproduction test case linked" : "Reproduction test case partially linked"}
        </div>
        <Badge variant={result.success ? "default" : "secondary"}>{result.mode === "suggested" ? "Suggested" : "Existing"}</Badge>
      </div>
      <div className="mt-2 grid gap-1 text-xs">
        <StatusLine label="Test case" success={Boolean(result.azureTestCaseId)} detail={result.azureTestCaseId ? `Azure ${result.azureTestCaseId}` : result.error} />
        {result.mode === "suggested" ? <StatusLine label="Create" success={result.create?.success} detail={result.create?.error} /> : null}
        {result.mode === "suggested" ? <StatusLine label="Story link" success={result.storyLink?.success} detail={result.storyLink?.error} /> : null}
        <StatusLine label="Bug link" success={result.bugLink?.success} detail={result.bugLink?.error} />
      </div>
    </div>
  );
}

function StatusLine({ label, success, detail }: { label: string; success?: boolean; detail?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="font-medium">{label}:</span>
      <span>{success ? "Success" : "Failed"}</span>
      {detail ? <span className="break-words opacity-80">{detail}</span> : null}
    </div>
  );
}

function CustomFieldsEditor({
  rows,
  fields,
  datalistId,
  onAdd,
  onRemove,
  onChange,
}: {
  rows: CustomFieldRow[];
  fields: BugFieldMetadata[];
  datalistId: string;
  onAdd: () => void;
  onRemove: (rowId: string) => void;
  onChange: (rowId: string, patch: Partial<CustomFieldRow>) => void;
}) {
  return (
    <div className="grid gap-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <Label>Azure DevOps fields</Label>
          <p className="mt-1 text-xs text-muted-foreground">Required and custom Bug fields.</p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={onAdd}>
          <Plus className="size-4" />
          Add field
        </Button>
      </div>
      <datalist id={datalistId}>
        {fields
          .filter((field) => !field.readOnly && !reservedBugFields.has(field.referenceName))
          .map((field) => (
            <option key={field.referenceName} value={field.referenceName}>
              {field.name}
            </option>
          ))}
      </datalist>
      {rows.length ? (
        <div className="grid gap-2">
          {rows.map((row) => {
            const metadataField = findField(fields, row.referenceName);
            return (
              <div key={row.id} className="grid gap-2 rounded-md border border-input p-3 lg:grid-cols-[minmax(220px,320px)_1fr_42px]">
                <Input
                  list={datalistId}
                  value={row.referenceName}
                  onChange={(event) => onChange(row.id, { referenceName: event.target.value })}
                  placeholder="Field reference name"
                  aria-label="Azure DevOps field reference name"
                />
                <CustomFieldValueInput row={row} field={metadataField} onChange={(value) => onChange(row.id, { value })} />
                <Button type="button" variant="ghost" size="icon" onClick={() => onRemove(row.id)} aria-label="Remove custom field">
                  <Trash2 className="size-4" />
                </Button>
                <div className="text-xs text-muted-foreground lg:col-span-3">
                  {metadataField ? `${metadataField.name}${metadataField.alwaysRequired || metadataField.required ? " - required" : ""}` : "Manual field fallback"}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="rounded-md border border-dashed border-input bg-muted/20 p-4 text-sm text-muted-foreground">No custom fields added.</div>
      )}
    </div>
  );
}

function CustomFieldsSummary({ customFields }: { customFields: BugCustomField[] }) {
  return (
    <div className="rounded-md border border-input bg-muted/20 p-3">
      <div className="flex items-center justify-between gap-3">
        <Label>Azure DevOps fields</Label>
        <Badge variant="secondary">{customFields.length} selected</Badge>
      </div>
      {customFields.length ? (
        <div className="mt-3 grid gap-2">
          {customFields.map((field) => (
            <div key={field.referenceName} className="grid gap-1 rounded-md bg-background px-3 py-2 text-sm sm:grid-cols-[minmax(180px,260px)_1fr]">
              <span className="font-medium text-muted-foreground">{field.name ?? field.referenceName}</span>
              <span className="break-words text-foreground">{String(field.value || "-")}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-3 rounded-md border border-dashed border-input bg-background px-3 py-2 text-sm text-muted-foreground">
          No extra Azure DevOps fields added.
        </div>
      )}
    </div>
  );
}

function CustomFieldValueInput({ row, field, onChange }: { row: CustomFieldRow; field?: BugFieldMetadata; onChange: (value: string) => void }) {
  if (field?.allowedValues?.length) {
    return (
      <select value={row.value} onChange={(event) => onChange(event.target.value)} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
        <option value="">Select value</option>
        {field.allowedValues.map((value) => (
          <option key={String(value)} value={String(value)}>
            {String(value)}
          </option>
        ))}
      </select>
    );
  }

  if (field?.type === "boolean") {
    return (
      <select value={row.value} onChange={(event) => onChange(event.target.value)} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
        <option value="">Select value</option>
        <option value="true">True</option>
        <option value="false">False</option>
      </select>
    );
  }

  if (field?.type === "plainText" || field?.type === "html" || row.value.length > 100) {
    return <Textarea value={row.value} onChange={(event) => onChange(event.target.value)} placeholder="Field value" />;
  }

  return (
    <Input
      type={field?.type === "integer" || field?.type === "double" || field?.type?.startsWith("picklist") ? "text" : "text"}
      value={row.value}
      onChange={(event) => onChange(event.target.value)}
      placeholder="Field value"
    />
  );
}

function PostSuccess({ result }: { result: PostBugResult }) {
  const failedAttachments = result.attachmentResults.filter((attachment) => !attachment.success);
  return (
    <div className="space-y-3">
      <div className="rounded-md border border-success/30 bg-success/10 p-4 text-sm text-foreground">
        <div className="flex items-center gap-2 font-semibold">
          <CheckCircle2 className="size-4" />
          Bug {result.bugId} created
        </div>
        <a href={result.webUrl} target="_blank" rel="noreferrer" className="mt-2 inline-block font-medium text-success underline">
          View in Azure DevOps
        </a>
      </div>
      {failedAttachments.length ? (
        <div className="rounded-md border border-warning/40 bg-warning/15 p-4 text-sm text-foreground">
          <div className="flex items-center gap-2 font-semibold">
            <AlertTriangle className="size-4" />
            Some attachments were not added
          </div>
          <div className="mt-2 grid gap-1">
            {failedAttachments.map((attachment) => (
              <div key={attachment.fileName}>{attachment.fileName}: {attachment.error ?? "Attachment failed."}</div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ErrorBlock({ message }: { message: string }) {
  return (
    <Callout tone="error" title="Action failed">
      <span className="break-words">{message}</span>
    </Callout>
  );
}

function WarningBlock({ message }: { message: string }) {
  return <Callout tone="warning">{message}</Callout>;
}

function InfoBlock({ message }: { message: string }) {
  return <div className="rounded-md border border-input bg-muted/20 p-3 text-sm text-muted-foreground">{message}</div>;
}

function buildSuggestedTestCaseFromBugReport(report: BugReport, sourceBugDescription: string): GeneratedTestCase {
  const parsedSteps = parseBugSteps(report.stepsToReproduce);
  const reproductionSteps = parsedSteps.length ? parsedSteps : [report.stepsToReproduce || sourceBugDescription || report.title];
  const steps: GeneratedTestCase["steps"] = [
    {
      stepNumber: 1,
      action: `Preconditions:\n${report.precondition || "No specific preconditions were generated."}`,
      expectedResult: "Preconditions are met",
    },
    ...reproductionSteps.map((step, index) => ({
      stepNumber: index + 2,
      action: step,
      expectedResult: index === reproductionSteps.length - 1 ? report.expectedResult : "Step completes successfully.",
    })),
  ];

  return {
    id: createLocalId("bug-repro-tc"),
    title: buildReproductionTestCaseTitle(report),
    description: [
      sourceBugDescription.trim() ? `Bug description:\n${sourceBugDescription.trim()}` : "",
      report.actualResult ? `Actual result to prevent:\n${report.actualResult}` : "",
    ].filter(Boolean).join("\n\n"),
    priority: report.priority,
    type: "regression",
    category: report.category || "Functional",
    preconditions: report.precondition,
    testData: report.systemInfo || report.environment || "",
    steps,
  };
}

function buildReproductionTestCaseTitle(report: BugReport) {
  const expectedBehaviorTitle = testCaseTitleFromExpectedResult(report.expectedResult);
  if (expectedBehaviorTitle && !sameText(expectedBehaviorTitle, report.title)) return expectedBehaviorTitle;

  const firstStep = parseBugSteps(report.stepsToReproduce)[0];
  const stepTitle = firstStep ? compactText(`Verify reproduction flow: ${firstStep}`) : "";
  if (stepTitle && !sameText(stepTitle, report.title)) return truncateText(stepTitle, 140);

  const category = report.category || "reported defect";
  return `Verify ${category.toLowerCase()} reproduction scenario`;
}

function testCaseTitleFromExpectedResult(value: string) {
  const expected = compactText(value).split(/(?<=[.!?])\s+|,\s+/)[0]?.replace(/[.!?]+$/, "").trim();
  if (!expected) return "";

  const systemShould = expected.match(/^the\s+system\s+should\s+(.+)$/i);
  if (systemShould?.[1]) return truncateText(`Verify the system ${systemShould[1]}`, 140);

  const shouldMatch = expected.match(/^(.+?)\s+should\s+(.+)$/i);
  if (shouldMatch?.[1] && shouldMatch[2]) {
    return truncateText(`Verify ${shouldMatch[1].trim()} ${shouldMatch[2].trim()}`, 140);
  }

  return truncateText(`Verify ${expected}`, 140);
}

function compactText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function truncateText(value: string, maxLength: number) {
  const normalized = compactText(value);
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}

function sameText(first: string, second: string) {
  return compactText(first).toLowerCase() === compactText(second).toLowerCase();
}

function parseBugSteps(value: string) {
  const normalized = value.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];
  const numberedMatches = [...normalized.matchAll(/(?:^|\n)\s*(?:\d+[\).\:-]\s+)([\s\S]*?)(?=\n\s*\d+[\).\:-]\s+|$)/g)]
    .map((match) => match[1].trim())
    .filter(Boolean);
  if (numberedMatches.length) return numberedMatches;
  return normalized.split("\n").map((line) => line.trim()).filter(Boolean);
}

function testCaseId(testCase: LinkedTestCase) {
  return testCase.azureTestCaseId ?? testCase.id;
}

function buildRequiredFieldRows(fields: BugFieldMetadata[]): CustomFieldRow[] {
  return fields
    .filter((field) => (field.alwaysRequired || field.required) && !field.readOnly && !reservedBugFields.has(field.referenceName))
    .map((field) => ({
      id: createLocalId(field.referenceName),
      referenceName: field.referenceName,
      name: field.name,
      value: defaultFieldValue(field),
    }));
}

function rowsToCustomFields(rows: CustomFieldRow[], fields: BugFieldMetadata[]): BugCustomField[] {
  const customFields: BugCustomField[] = [];
  for (const row of rows) {
    const field = findField(fields, row.referenceName);
    const referenceName = field?.referenceName ?? row.referenceName.trim();
    if (!referenceName) continue;
    if (reservedBugFields.has(referenceName)) continue;
    customFields.push({
      referenceName,
      name: field?.name ?? row.name,
      value: coerceCustomFieldValue(row.value, field),
    });
  }
  return customFields;
}

function customFieldsToRows(customFields: BugCustomField[], fields: BugFieldMetadata[]): CustomFieldRow[] {
  if (!customFields.length) return buildRequiredFieldRows(fields);
  return customFields
    .filter((field) => !reservedBugFields.has(findField(fields, field.referenceName)?.referenceName ?? field.referenceName))
    .map((field) => {
      const metadataField = findField(fields, field.referenceName);
      return {
        id: createLocalId(field.referenceName),
        referenceName: metadataField?.referenceName ?? field.referenceName,
        name: metadataField?.name ?? field.name,
        value: String(field.value ?? ""),
      };
    });
}

function mergeCustomFields(existing: BugCustomField[], generated: BugCustomField[]) {
  const merged = new Map<string, BugCustomField>();
  generated.filter((field) => !reservedBugFields.has(field.referenceName)).forEach((field) => merged.set(field.referenceName.toLowerCase(), field));
  existing.filter((field) => !reservedBugFields.has(field.referenceName)).forEach((field) => merged.set(field.referenceName.toLowerCase(), field));
  return [...merged.values()];
}

function coerceCustomFieldValue(value: string, field?: BugFieldMetadata): FieldValue {
  if (field?.allowedValues?.length) {
    const matched = field.allowedValues.find((allowed) => String(allowed).toLowerCase() === value.toLowerCase());
    if (matched !== undefined) return matched;
  }
  if (field?.type === "integer" || field?.type === "picklistInteger") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : value;
  }
  if (field?.type === "double" || field?.type === "picklistDouble") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : value;
  }
  if (field?.type === "boolean") {
    if (/^(true|yes|1)$/i.test(value.trim())) return true;
    if (/^(false|no|0)$/i.test(value.trim())) return false;
  }
  return value;
}

function findField(fields: BugFieldMetadata[], value: string) {
  const normalized = value.trim().toLowerCase();
  return fields.find((field) => field.referenceName.toLowerCase() === normalized || field.name.toLowerCase() === normalized);
}

function defaultFieldValue(field: BugFieldMetadata) {
  if (field.defaultValue !== undefined && field.defaultValue !== null) return String(field.defaultValue);
  return "";
}

function createLocalId(prefix: string) {
  return `${prefix.replace(/[^a-z0-9]/gi, "-")}-${Math.random().toString(36).slice(2, 9)}`;
}

function formatFileSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

const reservedBugFields = new Set([
  "System.Title",
  "System.State",
  "Microsoft.VSTS.TCM.ReproSteps",
  "Microsoft.VSTS.Common.Priority",
  "Microsoft.VSTS.Common.Severity",
  "System.AssignedTo",
  "System.AreaPath",
  "System.AreaId",
  "System.IterationPath",
  "System.IterationId",
  "Microsoft.VSTS.Common.ValueArea",
]);
