"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, Copy, FileUp, Loader2, Play, Plus, Send, Trash2, User, X } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { readActiveProject, type ActiveProjectScope } from "@/shared/lib/active-project";

type WorkflowMode = "auto" | "manual";
type FieldValue = string | number | boolean;

type ApiState<T> = {
  loading: boolean;
  error: string | null;
  data: T | null;
};

type ProjectUser = {
  id: string;
  displayName: string;
  uniqueName?: string;
  imageUrl?: string;
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

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
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

export function BugCreateClient() {
  const reviewSectionRef = useRef<HTMLDivElement | null>(null);
  const shouldScrollToReviewRef = useRef(false);
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
  const [generateState, setGenerateState] = useState<ApiState<BugReport>>({ loading: false, error: null, data: null });
  const [manualDraft, setManualDraft] = useState<ApiState<ManualPromptDraft>>({ loading: false, error: null, data: null });
  const [manualResponse, setManualResponse] = useState("");
  const [manualSubmitLoading, setManualSubmitLoading] = useState(false);
  const [manualSubmitError, setManualSubmitError] = useState<string | null>(null);
  const [report, setReport] = useState<BugReport | null>(null);
  const [postState, setPostState] = useState<ApiState<PostBugResult>>({ loading: false, error: null, data: null });

  const fields = useMemo(() => metadata.data?.fields ?? [], [metadata.data?.fields]);
  const users = useMemo(() => metadata.data?.users ?? [], [metadata.data?.users]);
  const areas = useMemo(() => metadata.data?.areas ?? [], [metadata.data?.areas]);
  const iterations = useMemo(() => metadata.data?.iterations ?? [], [metadata.data?.iterations]);
  const fieldOptionsId = "bug-custom-field-options";
  const parentStoryInvalid = Boolean(parentStory && parentStory.workItemType !== "User Story");
  const customFields = useMemo(() => rowsToCustomFields(customFieldRows, fields), [customFieldRows, fields]);

  useEffect(() => {
    setScope(readActiveProject());
    const onChange = (event: Event) => {
      const custom = event as CustomEvent<ActiveProjectScope>;
      setScope(custom.detail ?? readActiveProject());
      setParentStoryId("");
      setParentStory(null);
      setAssignedTo("");
      setSelectedAreaPath("");
      setSelectedIterationPath("");
      setAttachments([]);
      setCustomFieldRows([]);
      setReport(null);
      setPostState({ loading: false, error: null, data: null });
    };
    window.addEventListener("itestflow:active-project-changed", onChange);
    return () => window.removeEventListener("itestflow:active-project-changed", onChange);
  }, []);

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
    setParentStoryId(value.replace(/\D/g, "").slice(0, 10));
    setParentStory(null);
    setParentState({ loading: false, error: null, data: null });
    resetManual();
    setPostState({ loading: false, error: null, data: null });
  }

  function changeBugDescription(value: string) {
    setBugDescription(value);
    resetManual();
  }

  function resetManual() {
    setManualDraft({ loading: false, error: null, data: null });
    setManualResponse("");
    setManualSubmitError(null);
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
    if (!report || !shouldScrollToReviewRef.current) return;
    shouldScrollToReviewRef.current = false;
    reviewSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [report]);

  async function generate() {
    if (!scope || !bugDescription.trim() || parentStoryInvalid) return;
    setGenerateState({ loading: true, error: null, data: null });
    setPostState({ loading: false, error: null, data: null });
    try {
      const data = await postJson<BugReport>("/api/bugs/generate", buildGenerationPayload(scope));
      applyGeneratedReport(data);
      setGenerateState({ loading: false, error: null, data });
    } catch (error) {
      setGenerateState({ loading: false, error: error instanceof Error ? error.message : "Bug report generation failed.", data: null });
    }
  }

  async function prepareManualPrompt() {
    if (!scope || !bugDescription.trim() || parentStoryInvalid) return;
    setManualDraft({ loading: true, error: null, data: null });
    setManualSubmitError(null);
    setManualResponse("");
    try {
      const data = await postJson<ManualPromptDraft>("/api/bugs/manual/draft", buildGenerationPayload(scope));
      setManualDraft({ loading: false, error: null, data });
    } catch (error) {
      setManualDraft({ loading: false, error: error instanceof Error ? error.message : "External LLM prompt preparation failed.", data: null });
    }
  }

  async function submitManualResponse() {
    if (!scope || !manualResponse.trim()) return;
    setManualSubmitLoading(true);
    setManualSubmitError(null);
    try {
      const data = await postJson<BugReport>("/api/bugs/manual/submit", {
        scope,
        parentStoryId: parentStoryId.trim() || undefined,
        rawOutput: manualResponse,
      });
      applyGeneratedReport(data);
      setGenerateState({ loading: false, error: null, data });
    } catch (error) {
      setManualSubmitError(error instanceof Error ? error.message : "External LLM response validation failed.");
    } finally {
      setManualSubmitLoading(false);
    }
  }

  function buildGenerationPayload(activeScope: ActiveProjectScope) {
    return {
      scope: activeScope,
      bugDescription,
      parentStoryId: parentStoryId.trim() || undefined,
      customFields,
      attachments: attachments.map((file) => ({ fileName: file.name, contentType: file.type || undefined, size: file.size })),
    };
  }

  function applyGeneratedReport(data: BugReport) {
    const mergedCustomFields = mergeCustomFields(customFields, data.customFields ?? []);
    const nextReport = { ...data, customFields: mergedCustomFields };
    shouldScrollToReviewRef.current = true;
    setReport(nextReport);
    setCustomFieldRows(customFieldsToRows(mergedCustomFields, fields));
  }

  function updateReport<K extends keyof BugReport>(key: K, value: BugReport[K]) {
    setReport((current) => (current ? { ...current, [key]: value } : current));
    setPostState({ loading: false, error: null, data: null });
  }

  function updateCustomFieldRow(rowId: string, patch: Partial<CustomFieldRow>) {
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
    setCustomFieldRows((current) => [...current, { id: createLocalId("field"), referenceName: "", value: "" }]);
  }

  function removeCustomFieldRow(rowId: string) {
    setCustomFieldRows((current) => current.filter((row) => row.id !== rowId));
  }

  async function postBug() {
    if (!scope || !report || parentStoryInvalid) return;
    setPostState({ loading: true, error: null, data: null });
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
      setPostState({ loading: false, error: null, data: json as PostBugResult });
    } catch (error) {
      setPostState({ loading: false, error: error instanceof Error ? error.message : "Azure DevOps bug creation failed.", data: null });
    }
  }

  const generateDisabled = !scope || !bugDescription.trim() || generateState.loading || manualDraft.loading || parentStoryInvalid;
  const postDisabled = !scope || !report || !report.title.trim() || !report.actualResult.trim() || !report.stepsToReproduce.trim() || postState.loading || parentStoryInvalid;

  return (
    <div className="space-y-5">
      {!scope ? <WarningBlock message="Please select an Azure DevOps project before creating a bug." /> : null}
      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle className="text-base">Step 1 - Describe Bug</CardTitle>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">Capture the defect, parent story, Azure fields, assignee, and evidence.</p>
          </div>
          <ModeTabs mode={mode} onChange={setMode} />
        </CardHeader>
        <CardContent className="space-y-5 pt-5">
          {metadata.error ? <ErrorBlock message={metadata.error} /> : null}
          <Field label="Bug description">
            <Textarea
              value={bugDescription}
              onChange={(event) => changeBugDescription(event.target.value)}
              className="min-h-32"
              placeholder="Describe what went wrong, where it happened, and what you expected instead."
            />
          </Field>

          <div className="grid gap-4 lg:grid-cols-[minmax(260px,360px)_1fr]">
            <Field label="Parent Story ID">
              <Input
                value={parentStoryId}
                onChange={(event) => changeParentStoryId(event.target.value)}
                inputMode="numeric"
                maxLength={10}
                placeholder="e.g. 358867"
              />
            </Field>
            <ParentStoryPanel story={parentStory} loading={parentState.loading} error={parentState.error} />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Field label="Assignee">
              <AssigneePicker
                value={assignedTo}
                users={users}
                loading={metadata.loading}
                disabled={!scope}
                onChange={setAssignedTo}
              />
            </Field>
            <Field label="Area path">
              <select
                value={selectedAreaPath}
                onChange={(event) => setSelectedAreaPath(event.target.value)}
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
                onChange={(event) => setSelectedIterationPath(event.target.value)}
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
                  onChange={(event) => setAttachments(Array.from(event.target.files ?? []))}
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

          <div className="flex justify-end">
            {mode === "auto" ? (
              <Button type="button" onClick={generate} disabled={generateDisabled}>
                {generateState.loading ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
                {generateState.loading ? "Generating..." : "Generate"}
              </Button>
            ) : (
              <Button type="button" onClick={prepareManualPrompt} disabled={generateDisabled}>
                {manualDraft.loading ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
                {manualDraft.loading ? "Preparing..." : "Prepare Prompt"}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {mode === "manual" ? (
        <ManualLLMPanel
          draft={manualDraft.data}
          response={manualResponse}
          onResponseChange={setManualResponse}
          onSubmit={submitManualResponse}
          submitting={manualSubmitLoading}
          error={manualDraft.error ?? manualSubmitError}
        />
      ) : null}

      {generateState.error ? <ErrorBlock message={generateState.error} /> : null}

      {report ? (
        <Card ref={reviewSectionRef}>
          <CardHeader>
            <CardTitle className="text-base">Step 3 - Review & Post</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5 pt-5">
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(220px,280px)_minmax(220px,280px)]">
              <Field label="Title">
                <Input value={report.title} onChange={(event) => updateReport("title", event.target.value)} />
              </Field>
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
            <Field label="System Info">
              <Textarea value={report.systemInfo} onChange={(event) => updateReport("systemInfo", event.target.value)} />
            </Field>

            <CustomFieldsSummary customFields={customFields} />

            {postState.error ? <ErrorBlock message={postState.error} /> : null}
            {postState.data ? <PostSuccess result={postState.data} /> : null}

            <div className="flex justify-end">
              <Button type="button" onClick={postBug} disabled={postDisabled}>
                {postState.loading ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                {postState.loading ? "Posting..." : "Post to Azure DevOps"}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <EmptyBlock message="No bug report draft yet. Generate one from the description to review it here." />
      )}
    </div>
  );
}

function ModeTabs({ mode, onChange }: { mode: WorkflowMode; onChange: (mode: WorkflowMode) => void }) {
  const itemClass = (value: WorkflowMode) =>
    `h-8 rounded-md px-3 text-sm font-medium transition ${
      mode === value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"
    }`;

  return (
    <div role="tablist" aria-label="LLM execution mode" className="inline-flex rounded-lg border border-input bg-background p-1">
      <button type="button" role="tab" aria-selected={mode === "auto"} className={itemClass("auto")} onClick={() => onChange("auto")}>
        Auto Generate
      </button>
      <button type="button" role="tab" aria-selected={mode === "manual"} className={itemClass("manual")} onClick={() => onChange("manual")}>
        External LLM
      </button>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-2">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function AssigneePicker({
  value,
  users,
  loading,
  disabled,
  onChange,
}: {
  value: string;
  users: ProjectUser[];
  loading: boolean;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selectedUser = users.find((user) => assigneeValue(user) === value);
  const selectedLabel = selectedUser ? projectUserLabel(selectedUser) : value;
  const triggerLabel = loading ? "Loading users..." : selectedLabel || "Unassigned";

  function selectUser(user: ProjectUser) {
    onChange(assigneeValue(user));
    setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <div className="flex gap-2">
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            disabled={disabled || loading}
            className="h-10 min-w-0 flex-1 justify-between px-3"
          >
            <span className="inline-flex min-w-0 items-center gap-2">
              {selectedUser ? (
                <Avatar size="sm">
                  {selectedUser.imageUrl ? <AvatarImage src={selectedUser.imageUrl} alt="" /> : null}
                  <AvatarFallback>{initialsFromName(selectedUser.displayName)}</AvatarFallback>
                </Avatar>
              ) : loading ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <User className="size-4" />
              )}
              <span className="truncate">{triggerLabel}</span>
            </span>
            <ChevronDown className={`size-4 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
          </Button>
        </PopoverTrigger>
        {value ? (
          <Button type="button" variant="ghost" size="icon" onClick={() => onChange("")} aria-label="Clear assignee">
            <X className="size-4" />
          </Button>
        ) : null}
      </div>
      <PopoverContent align="start" className="w-[380px] max-w-[calc(100vw-2rem)] p-0">
        <Command>
          <CommandInput placeholder="Search project users" />
          <CommandList>
            {loading ? (
              <div className="flex items-center gap-2 px-3 py-4 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Loading project users
              </div>
            ) : null}
            {!loading ? (
              <>
                <CommandEmpty>No project users found.</CommandEmpty>
                <CommandGroup>
                  <CommandItem value="Unassigned" data-checked={!value} onSelect={() => { onChange(""); setOpen(false); }}>
                    <User className="size-4" />
                    Unassigned
                  </CommandItem>
                  {users.map((user) => {
                    const userValue = assigneeValue(user);
                    return (
                      <CommandItem
                        key={user.id}
                        value={projectUserLabel(user)}
                        data-checked={value === userValue}
                        onSelect={() => selectUser(user)}
                        className="items-start gap-3 py-2"
                      >
                        <Avatar size="sm" className="mt-0.5">
                          {user.imageUrl ? <AvatarImage src={user.imageUrl} alt="" /> : null}
                          <AvatarFallback>{initialsFromName(user.displayName)}</AvatarFallback>
                        </Avatar>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium">{user.displayName}</div>
                          {user.uniqueName ? <div className="truncate text-xs text-muted-foreground">{user.uniqueName}</div> : null}
                        </div>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              </>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
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
    <div className="grid gap-2 rounded-md border border-input bg-muted/20 p-3">
      <div className="flex min-h-6 items-center justify-between gap-2">
        <Label>{label}</Label>
        <Badge variant="secondary" className="shrink-0">LLM suggested</Badge>
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
      {rationale ? (
        <p className="min-h-10 text-xs leading-5 text-muted-foreground">
          {rationale}
        </p>
      ) : (
        <p className="min-h-10 text-xs leading-5 text-muted-foreground">No rationale provided.</p>
      )}
    </div>
  );
}

function ParentStoryPanel({ story, loading, error }: { story: WorkItem | null; loading: boolean; error: string | null }) {
  if (loading) return <InfoBlock message="Loading parent story..." />;
  if (error) return <ErrorBlock message={error} />;
  if (!story) return <InfoBlock message="No parent story loaded." />;

  const valid = story.workItemType === "User Story";
  return (
    <div className={`rounded-md border p-3 text-sm ${valid ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-amber-200 bg-amber-50 text-amber-900"}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">#{story.id}</span>
        <Badge variant={valid ? "default" : "secondary"}>{story.workItemType}</Badge>
        {!valid ? <span className="text-xs font-medium">Parent link requires a User Story.</span> : null}
      </div>
      <div className="mt-2 font-medium">{story.title}</div>
      <div className="mt-2 grid gap-1 text-xs">
        {story.areaPath ? <span>Area: {story.areaPath}</span> : null}
        {story.iterationPath ? <span>Iteration: {story.iterationPath}</span> : null}
      </div>
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

function ManualLLMPanel({
  draft,
  response,
  onResponseChange,
  onSubmit,
  submitting,
  error,
}: {
  draft: ManualPromptDraft | null;
  response: string;
  onResponseChange: (value: string) => void;
  onSubmit: () => void;
  submitting: boolean;
  error?: string | null;
}) {
  const [copied, setCopied] = useState(false);
  if (!draft && !error) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Step 2 - External LLM</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 pt-5">
        {error ? <ErrorBlock message={error} /> : null}
        {draft ? (
          <>
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-semibold">Prompt {draft.promptVersion}</span>
              <Button
                type="button"
                variant="outline"
                disabled={copied}
                onClick={() => {
                  void navigator.clipboard.writeText(draft.prompt);
                  setCopied(true);
                }}
              >
                <Copy className="size-4" />
                {copied ? "Copied" : "Copy Prompt"}
              </Button>
            </div>
            <Textarea value={draft.prompt} readOnly className="min-h-[320px] font-mono text-xs" aria-label="External LLM prompt" />
            <Field label="External LLM response">
              <Textarea
                value={response}
                onChange={(event) => onResponseChange(event.target.value)}
                className="min-h-[240px] font-mono text-xs"
                placeholder="Paste the JSON response here."
              />
            </Field>
            <div className="flex justify-end">
              <Button type="button" onClick={onSubmit} disabled={!response.trim() || submitting}>
                {submitting ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
                {submitting ? "Validating..." : "Validate and Continue"}
              </Button>
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

function PostSuccess({ result }: { result: PostBugResult }) {
  const failedAttachments = result.attachmentResults.filter((attachment) => !attachment.success);
  return (
    <div className="space-y-3">
      <div className="rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
        <div className="flex items-center gap-2 font-semibold">
          <CheckCircle2 className="size-4" />
          Bug {result.bugId} created
        </div>
        <a href={result.webUrl} target="_blank" rel="noreferrer" className="mt-2 inline-block font-medium text-emerald-800 underline">
          View in Azure DevOps
        </a>
      </div>
      {failedAttachments.length ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
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
    <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-900">
      <div className="flex items-center gap-2 font-semibold text-red-800">
        <AlertTriangle className="size-4 shrink-0" />
        Action failed
      </div>
      <p className="mt-2 break-words text-red-800">{message}</p>
    </div>
  );
}

function WarningBlock({ message }: { message: string }) {
  return (
    <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
      <div className="flex items-center gap-2">
        <AlertTriangle className="size-4" />
        {message}
      </div>
    </div>
  );
}

function InfoBlock({ message }: { message: string }) {
  return <div className="rounded-md border border-input bg-muted/20 p-3 text-sm text-muted-foreground">{message}</div>;
}

function EmptyBlock({ message }: { message: string }) {
  return (
    <div className="rounded-md border border-dashed border-input bg-background p-6 text-sm text-muted-foreground">
      <div className="flex items-center gap-2">
        <CheckCircle2 className="size-4 text-primary" />
        {message}
      </div>
    </div>
  );
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

function assigneeValue(user: ProjectUser) {
  return user.uniqueName ?? user.displayName;
}

function projectUserLabel(user: ProjectUser) {
  return user.uniqueName ? `${user.displayName} (${user.uniqueName})` : user.displayName;
}

function initialsFromName(value?: string) {
  if (!value) return "AD";
  const words = value.trim().split(/\s+/).filter(Boolean);
  return words.slice(0, 2).map((word) => word[0]?.toUpperCase()).join("") || "AD";
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
