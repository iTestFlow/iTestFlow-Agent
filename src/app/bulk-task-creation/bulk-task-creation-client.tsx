"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpDown,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ClipboardList,
  Clock3,
  Info,
  Layers3,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Send,
  Trash2,
  TriangleAlert,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchableMultiSelect } from "@/components/ui/searchable-multi-select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Callout } from "@/components/qa/callout";
import { useUnsavedChangesGuard } from "@/components/navigation/unsaved-changes-provider";
import { ProjectUserPicker, projectUserLabel, projectUserValue } from "@/components/domain/project-user-picker";
import { StatCard } from "@/components/qa/stat-card";
import { StickyActionBar } from "@/components/workflow/sticky-action-bar";
import { WorkflowStepper } from "@/components/workflow/workflow-stepper";
import { cn } from "@/lib/utils";
import { readActiveProject, type ActiveProjectScope } from "@/shared/lib/active-project";
import type { ProjectUser } from "@/types/azure-devops";

type TargetMode = "iteration" | "manual";
type WorkflowStepId = "task-templates" | "target-stories" | "review-create";
type StorySortKey = "state" | "assignedTo";
type SortDirection = "asc" | "desc";

type AzureIteration = {
  id: string;
  name: string;
  path: string;
  startDate?: string;
  finishDate?: string;
};

type UserStory = {
  id: string;
  workItemType: string;
  title: string;
  state?: string;
  assignedTo?: string;
  areaPath?: string;
  iterationPath?: string;
};

type TargetRow = {
  key: string;
  storyId: string;
  title?: string;
  state?: string;
  assignedTo?: string;
  iterationPath?: string;
};

type TaskDefinition = {
  id: string;
  title: string;
  description: string;
  assignedTo: string;
  originalEstimate: string;
  copyEstimateToRemainingWork: boolean;
};

type TaskDefinitionIssue = {
  field: "title" | "estimate";
  message: string;
  summary: string;
};

type BulkTaskPairResult = {
  templateId: string;
  storyId: string;
  title: string;
  status: "created" | "failed" | "skipped";
  taskId?: string;
  error?: string;
};

type BulkTaskResponse = {
  requestedCount: number;
  taskTemplateCount: number;
  targetStoryCount: number;
  created: Array<{ templateId: string; storyId: string; taskId: string; title: string }>;
  skipped: Array<{ templateId: string; storyId: string; title: string; error: string }>;
  failed: Array<{ templateId: string; storyId: string; title: string; error: string }>;
  results: BulkTaskPairResult[];
};

type TaskOverrideValues = {
  assignedTo: string;
  originalEstimate: string;
};

type StoryTaskOverrides = Record<string, TaskOverrideValues>;

type ReviewWarning = {
  storyId: string;
  templateId: string;
  message: string;
};

const MAX_TASK_TEMPLATES = 20;
const MAX_TASK_CREATIONS = 1000;
const BULK_TASK_WORKFLOW_STEPS = [
  {
    id: "task-templates",
    label: "Task Templates",
    shortLabel: "Templates",
    description: "Define the tasks created under every selected story.",
  },
  {
    id: "target-stories",
    label: "Target Stories",
    shortLabel: "Stories",
    description: "Select target stories by sprint or project search.",
  },
  {
    id: "review-create",
    label: "Review & Create",
    shortLabel: "Review",
    description: "Review generated tasks and create the batch.",
  },
] as const;

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

export function BulkTaskCreationClient() {
  const [scope, setScope] = useState<ActiveProjectScope | null>(null);
  const [activeStepId, setActiveStepId] = useState<WorkflowStepId>("task-templates");
  const [targetMode, setTargetMode] = useState<TargetMode>("iteration");
  const [taskDefinitions, setTaskDefinitions] = useState<TaskDefinition[]>(() => [createEmptyTaskDefinition()]);
  const [iterations, setIterations] = useState<AzureIteration[]>([]);
  const [projectUsers, setProjectUsers] = useState<ProjectUser[]>([]);
  const [selectedIterationPath, setSelectedIterationPath] = useState("");
  const [iterationsLoading, setIterationsLoading] = useState(false);
  const [usersLoading, setUsersLoading] = useState(false);
  const [storiesLoading, setStoriesLoading] = useState(false);
  const [stories, setStories] = useState<UserStory[]>([]);
  const [selectedStoryIds, setSelectedStoryIds] = useState<string[]>([]);
  const [searchableStories, setSearchableStories] = useState<UserStory[]>([]);
  const [searchableStoriesLoading, setSearchableStoriesLoading] = useState(false);
  const [searchableStoriesLoaded, setSearchableStoriesLoaded] = useState(false);
  const [searchableStoriesError, setSearchableStoriesError] = useState<string | null>(null);
  const [selectedSearchableStoryIds, setSelectedSearchableStoryIds] = useState<string[]>([]);
  const [overrides, setOverrides] = useState<Record<string, StoryTaskOverrides>>({});
  const [collapsedTemplateIds, setCollapsedTemplateIds] = useState<string[]>([]);
  const [expandedStoryIds, setExpandedStoryIds] = useState<string[]>([]);
  const [selectedOnly, setSelectedOnly] = useState(false);
  const [submitLoading, setSubmitLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BulkTaskResponse | null>(null);
  const [hasUnfinishedWork, setHasUnfinishedWork] = useState(false);
  useUnsavedChangesGuard({ dirty: hasUnfinishedWork, busy: submitLoading });

  useEffect(() => {
    setScope(readActiveProject());
    const onChange = (event: Event) => {
      const custom = event as CustomEvent<ActiveProjectScope>;
      setScope(custom.detail ?? readActiveProject());
      setStories([]);
      setSearchableStories([]);
      setProjectUsers([]);
      setSelectedStoryIds([]);
      setSelectedSearchableStoryIds([]);
      setSearchableStoriesLoaded(false);
      setSearchableStoriesError(null);
      setSelectedIterationPath("");
      setOverrides({});
      setCollapsedTemplateIds([]);
      setExpandedStoryIds([]);
      setSelectedOnly(false);
      setActiveStepId("task-templates");
      setResult(null);
      setError(null);
      setHasUnfinishedWork(false);
    };
    window.addEventListener("itestflow:active-project-changed", onChange);
    return () => window.removeEventListener("itestflow:active-project-changed", onChange);
  }, []);

  useEffect(() => {
    if (!scope) return;
    let cancelled = false;

    setIterationsLoading(true);
    setUsersLoading(true);
    setIterations([]);
    setProjectUsers([]);
    setSelectedIterationPath("");

    void postJson<{ iterations: AzureIteration[] }>("/api/azure-devops/iterations", { scope })
      .then((data) => {
        if (cancelled) return;
        const nextIterations = data.iterations ?? [];
        setIterations(nextIterations);
        setSelectedIterationPath(findDefaultIterationPath(nextIterations));
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Azure DevOps iteration fetch failed.");
      })
      .finally(() => {
        if (!cancelled) setIterationsLoading(false);
      });

    void postJson<{ users: ProjectUser[] }>("/api/azure-devops/project-users", { scope })
      .then((data) => {
        if (cancelled) return;
        setProjectUsers(data.users ?? []);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Azure DevOps project user fetch failed.");
      })
      .finally(() => {
        if (!cancelled) setUsersLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [scope]);

  useEffect(() => {
    if (!scope || targetMode !== "manual" || searchableStoriesLoaded) return;

    let cancelled = false;
    setSearchableStoriesLoading(true);
    setSearchableStoriesError(null);

    void postJson<{ stories: UserStory[] }>("/api/azure-devops/user-stories", { scope })
      .then((data) => {
        if (cancelled) return;
        setSearchableStories(data.stories ?? []);
      })
      .catch((loadError: unknown) => {
        if (cancelled) return;
        setSearchableStoriesError(
          loadError instanceof Error ? loadError.message : "Azure DevOps user story fetch failed.",
        );
      })
      .finally(() => {
        if (cancelled) return;
        setSearchableStoriesLoading(false);
        setSearchableStoriesLoaded(true);
      });

    return () => {
      cancelled = true;
    };
  }, [scope, searchableStoriesLoaded, targetMode]);

  const targetRows = useMemo<TargetRow[]>(() => {
    if (targetMode === "manual") {
      const storyById = new Map(searchableStories.map((story) => [story.id, story]));
      return selectedSearchableStoryIds.flatMap((storyId) => {
        const story = storyById.get(storyId);
        if (!story) return [];
        return [{
          key: `search-${story.id}`,
          storyId: story.id,
          title: story.title,
          state: story.state,
          assignedTo: story.assignedTo,
          iterationPath: story.iterationPath,
        }];
      });
    }

    const selected = new Set(selectedStoryIds);
    return stories
      .filter((story) => selected.has(story.id))
      .map((story) => ({
        key: `story-${story.id}`,
        storyId: story.id,
        title: story.title,
        state: story.state,
        assignedTo: story.assignedTo,
        iterationPath: story.iterationPath,
      }));
  }, [searchableStories, selectedSearchableStoryIds, selectedStoryIds, stories, targetMode]);

  const resultsByStoryId = useMemo(() => {
    const map = new Map<string, BulkTaskPairResult[]>();
    result?.results.forEach((item) => {
      map.set(item.storyId, [...(map.get(item.storyId) ?? []), item]);
    });
    return map;
  }, [result]);

  const selectedIteration = iterations.find((iteration) => iteration.path === selectedIterationPath);
  const taskIssuesById = useMemo(
    () => buildTaskDefinitionIssues(taskDefinitions),
    [taskDefinitions],
  );
  const validTaskDefinitions = useMemo(
    () => taskDefinitions.filter((task) => !(taskIssuesById.get(task.id)?.length)),
    [taskDefinitions, taskIssuesById],
  );
  const requestedCount = taskDefinitions.length * targetRows.length;
  const reviewWarnings = useMemo(
    () => buildReviewWarnings(targetRows, taskDefinitions, overrides),
    [overrides, targetRows, taskDefinitions],
  );
  const totalEstimatedHours = useMemo(
    () => calculateTotalEstimatedHours(targetRows, taskDefinitions, overrides),
    [overrides, targetRows, taskDefinitions],
  );
  const blockingErrors = useMemo(
    () => buildBlockingErrors({
      scope,
      taskDefinitions,
      taskIssuesById,
      targetRows,
      overrides,
      requestedCount,
      result,
    }),
    [overrides, requestedCount, result, scope, targetRows, taskDefinitions, taskIssuesById],
  );
  const hasValidTemplate = validTaskDefinitions.length > 0;
  const canOpenTargetStories = hasValidTemplate;
  const canOpenReview = hasValidTemplate && targetRows.length > 0;
  const canSubmit = canOpenReview && blockingErrors.length === 0 && !submitLoading;

  useEffect(() => {
    if (activeStepId !== "review-create") return;
    const issueStoryIds = new Set<string>();
    result?.results.forEach((item) => {
      if (item.status !== "created") issueStoryIds.add(item.storyId);
    });
    if (!issueStoryIds.size) return;
    setExpandedStoryIds((current) => [...new Set([...current, ...issueStoryIds])]);
  }, [activeStepId, result]);

  async function reloadIterations() {
    if (!scope) return;
    setIterationsLoading(true);
    setError(null);
    try {
      const data = await postJson<{ iterations: AzureIteration[] }>("/api/azure-devops/iterations", { scope });
      const nextIterations = data.iterations ?? [];
      setIterations(nextIterations);
      setSelectedIterationPath((current) =>
        current && nextIterations.some((iteration) => iteration.path === current) ? current : findDefaultIterationPath(nextIterations),
      );
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Azure DevOps iteration fetch failed.");
    } finally {
      setIterationsLoading(false);
    }
  }

  async function loadStories() {
    if (!scope || !selectedIterationPath) return;
    setStoriesLoading(true);
    setError(null);
    setResult(null);
    setStories([]);
    setSelectedStoryIds([]);
    try {
      const data = await postJson<{ stories: UserStory[] }>("/api/azure-devops/user-stories", {
        scope,
        iterationPath: selectedIterationPath,
      });
      setStories(data.stories ?? []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Azure DevOps user story fetch failed.");
    } finally {
      setStoriesLoading(false);
    }
  }

  function toggleStory(storyId: string, checked: boolean) {
    setHasUnfinishedWork(true);
    setResult(null);
    setSelectedStoryIds((current) => checked ? [...new Set([...current, storyId])] : current.filter((id) => id !== storyId));
  }

  function toggleAllStories(checked: boolean, storyIds = stories.map((story) => story.id)) {
    setHasUnfinishedWork(true);
    setResult(null);
    if (checked) {
      setSelectedStoryIds((current) => [...new Set([...current, ...storyIds])]);
      return;
    }
    const loadedIds = new Set(storyIds);
    setSelectedStoryIds((current) => current.filter((id) => !loadedIds.has(id)));
  }

  function updateOverride(
    storyId: string,
    templateId: string,
    field: keyof TaskOverrideValues,
    value: string,
  ) {
    setHasUnfinishedWork(true);
    setResult(null);
    setOverrides((current) => ({
      ...current,
      [storyId]: {
        ...current[storyId],
        [templateId]: {
          assignedTo: current[storyId]?.[templateId]?.assignedTo ?? "",
          originalEstimate: current[storyId]?.[templateId]?.originalEstimate ?? "",
          [field]: value,
        },
      },
    }));
  }

  function updateTaskDefinition(id: string, updates: Partial<TaskDefinition>) {
    setHasUnfinishedWork(true);
    setResult(null);
    setTaskDefinitions((current) =>
      current.map((task) => task.id === id ? { ...task, ...updates } : task),
    );
  }

  function addTaskDefinition() {
    if (taskDefinitions.length >= MAX_TASK_TEMPLATES) return;
    setHasUnfinishedWork(true);
    setResult(null);
    setTaskDefinitions((current) => [...current, createEmptyTaskDefinition()]);
  }

  function removeTaskDefinition(id: string) {
    if (taskDefinitions.length <= 1) return;
    setHasUnfinishedWork(true);
    setResult(null);
    setTaskDefinitions((current) => current.filter((task) => task.id !== id));
    setCollapsedTemplateIds((current) => current.filter((templateId) => templateId !== id));
    setOverrides((current) => Object.fromEntries(
      Object.entries(current).map(([storyId, storyOverrides]) => {
        const nextStoryOverrides = { ...storyOverrides };
        delete nextStoryOverrides[id];
        return [storyId, nextStoryOverrides];
      }),
    ));
  }

  function toggleTemplateCollapsed(id: string) {
    setCollapsedTemplateIds((current) =>
      current.includes(id)
        ? current.filter((templateId) => templateId !== id)
        : [...current, id],
    );
  }

  function clearActiveSelection() {
    setHasUnfinishedWork(true);
    setResult(null);
    if (targetMode === "manual") {
      setSelectedSearchableStoryIds([]);
    } else {
      setSelectedStoryIds([]);
    }
    setSelectedOnly(false);
    setExpandedStoryIds([]);
  }

  function changeWorkflowStep(stepId: WorkflowStepId) {
    if (stepId === "target-stories" && !canOpenTargetStories) return;
    if (stepId === "review-create" && !canOpenReview) return;
    setActiveStepId(stepId);
  }

  function retrySearchableStories() {
    setSearchableStoriesError(null);
    setSearchableStoriesLoaded(false);
  }

  async function submit() {
    const validationError = blockingErrors[0];
    if (validationError) {
      setError(validationError);
      toast.error(validationError);
      return;
    }
    if (!scope) return;

    const targets = targetRows.map((row) => ({
      storyId: row.storyId,
      taskOverrides: taskDefinitions.flatMap((task) => {
        const taskOverride = overrides[row.storyId]?.[task.id];
        const assignedTo = optionalText(taskOverride?.assignedTo);
        const originalEstimate = parseOptionalEstimate(taskOverride?.originalEstimate);
        return assignedTo !== undefined || originalEstimate !== undefined
          ? [{ templateId: task.id, assignedTo, originalEstimate }]
          : [];
      }),
    }));

    setSubmitLoading(true);
    setError(null);
    setResult(null);
    try {
      const data = await postJson<BulkTaskResponse>("/api/azure-devops/bulk-tasks", {
        scope,
        taskTemplates: taskDefinitions.map((task) => ({
          templateId: task.id,
          title: task.title.trim(),
          description: optionalText(task.description),
          assignedTo: optionalText(task.assignedTo),
          originalEstimate: parseOptionalEstimate(task.originalEstimate),
          copyEstimateToRemainingWork: task.copyEstimateToRemainingWork,
        })),
        targets,
      });
      setResult(data);
      setActiveStepId("review-create");
      if (data.failed.length === 0) setHasUnfinishedWork(false);
      const summary = `Created ${data.created.length}, skipped ${data.skipped.length}, failed ${data.failed.length} of ${data.requestedCount} tasks.`;
      if (data.failed.length) toast.warning(summary);
      else toast.success(summary);
    } catch (submitError) {
      const message = submitError instanceof Error ? submitError.message : "Azure DevOps bulk task creation failed.";
      setError(message);
      toast.error(message);
    } finally {
      setSubmitLoading(false);
    }
  }

  return (
    <div className="space-y-5 pb-24">
      <WorkflowStepper
        steps={BULK_TASK_WORKFLOW_STEPS}
        activeStepId={activeStepId}
        completedStepIds={[
          ...(taskDefinitions.length > 0 && taskIssuesById.size === 0
            ? ["task-templates" as const]
            : []),
          ...(targetRows.length > 0 ? ["target-stories" as const] : []),
          ...(result && result.failed.length === 0 ? ["review-create" as const] : []),
        ]}
        enabledStepIds={[
          "task-templates",
          ...(canOpenTargetStories ? ["target-stories" as const] : []),
          ...(canOpenReview ? ["review-create" as const] : []),
        ]}
        onStepChange={changeWorkflowStep}
        ariaLabel="Bulk task creation workflow"
      />

      <Card className="qa-card">
        <CardContent className="p-4 sm:p-5">
          <WorkflowSummaryStrip
            templateCount={taskDefinitions.length}
            selectedStoriesCount={targetRows.length}
            requestedCount={requestedCount}
            totalEstimatedHours={totalEstimatedHours}
          />
        </CardContent>
      </Card>

      {!scope ? (
        <Callout tone="warning">Select an Azure DevOps project before creating tasks.</Callout>
      ) : null}

      {error ? <Callout tone="error">{error}</Callout> : null}

      {activeStepId === "task-templates" ? (
        <TaskTemplatesStep
          tasks={taskDefinitions}
          taskIssuesById={taskIssuesById}
          collapsedTemplateIds={collapsedTemplateIds}
          users={projectUsers}
          usersLoading={usersLoading}
          onAdd={addTaskDefinition}
          onRemove={removeTaskDefinition}
          onUpdate={updateTaskDefinition}
          onToggleCollapsed={toggleTemplateCollapsed}
          onContinue={() => changeWorkflowStep("target-stories")}
          canContinue={canOpenTargetStories}
        />
      ) : null}

      {activeStepId === "target-stories" ? (
        <TargetStoriesStep
          scope={scope}
          targetMode={targetMode}
          selectedCount={targetRows.length}
          iterations={iterations}
          selectedIterationPath={selectedIterationPath}
          selectedIteration={selectedIteration}
          iterationsLoading={iterationsLoading}
          storiesLoading={storiesLoading}
          stories={stories}
          selectedStoryIds={selectedStoryIds}
          selectedOnly={selectedOnly}
          searchableStories={searchableStories}
          selectedSearchableStoryIds={selectedSearchableStoryIds}
          searchableStoriesLoading={searchableStoriesLoading}
          searchableStoriesError={searchableStoriesError}
          onTargetModeChange={(value) => {
            setHasUnfinishedWork(true);
            setTargetMode(value);
            setResult(null);
            setSelectedOnly(false);
          }}
          onIterationChange={(value) => {
            setHasUnfinishedWork(true);
            setSelectedIterationPath(value);
          }}
          onReloadIterations={reloadIterations}
          onLoadStories={loadStories}
          onToggleStory={toggleStory}
          onToggleAll={toggleAllStories}
          onSelectedOnlyChange={setSelectedOnly}
          onSearchSelectionChange={(value) => {
            setHasUnfinishedWork(true);
            setSelectedSearchableStoryIds(value);
            setResult(null);
          }}
          onRetrySearch={retrySearchableStories}
          onClearSelection={clearActiveSelection}
          onBack={() => changeWorkflowStep("task-templates")}
          onReview={() => changeWorkflowStep("review-create")}
          canReview={canOpenReview}
        />
      ) : null}

      {activeStepId === "review-create" ? (
        <>
          <ReviewCreateStep
            rows={targetRows}
            tasks={taskDefinitions}
            overrides={overrides}
            users={projectUsers}
            usersLoading={usersLoading}
            resultsByStoryId={resultsByStoryId}
            expandedStoryIds={expandedStoryIds}
            reviewWarnings={reviewWarnings}
            totalEstimatedHours={totalEstimatedHours}
            onExpandedStoryIdsChange={setExpandedStoryIds}
            onOverrideChange={updateOverride}
            onBack={() => changeWorkflowStep("target-stories")}
          />
          {result ? <ResultPanel result={result} /> : null}
        </>
      ) : null}

      {activeStepId === "review-create" && canOpenReview ? (
        <StickyActionBar
          title={
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span>{targetRows.length} stories selected</span>
              <span className="text-muted-foreground">&middot;</span>
              <span>{taskDefinitions.length} templates</span>
              <span className="text-muted-foreground">&middot;</span>
              <span className="font-normal text-muted-foreground">{requestedCount} tasks will be created</span>
            </div>
          }
          actions={
            <Button type="button" size="lg" onClick={submit} disabled={!canSubmit}>
              {submitLoading ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
              {submitLoading ? "Creating tasks..." : `Create ${requestedCount} Tasks`}
            </Button>
          }
        />
      ) : null}
    </div>
  );
}

function WorkflowSummaryStrip({
  templateCount,
  selectedStoriesCount,
  requestedCount,
  totalEstimatedHours,
}: {
  templateCount: number;
  selectedStoriesCount: number;
  requestedCount: number;
  totalEstimatedHours: number;
}) {
  const items = [
    { label: "Templates", value: templateCount, icon: Layers3 },
    { label: "Stories", value: selectedStoriesCount, icon: BookOpen },
    { label: "Tasks ready", value: requestedCount, icon: ClipboardList },
    { label: "Estimated hours", value: formatHours(totalEstimatedHours), icon: Clock3 },
  ];

  return (
    <div className="grid grid-cols-2 gap-2 xl:grid-cols-4" aria-label="Bulk task summary">
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <div
            key={item.label}
            className="rounded-lg border border-border bg-muted/30 px-3 py-2"
          >
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Icon className="size-3.5" aria-hidden="true" />
              {item.label}
            </div>
            <div className="mt-1 text-lg font-semibold leading-none text-foreground">{item.value}</div>
          </div>
        );
      })}
    </div>
  );
}

function TaskTemplatesStep({
  tasks,
  taskIssuesById,
  collapsedTemplateIds,
  users,
  usersLoading,
  onAdd,
  onRemove,
  onUpdate,
  onToggleCollapsed,
  onContinue,
  canContinue,
}: {
  tasks: TaskDefinition[];
  taskIssuesById: Map<string, TaskDefinitionIssue[]>;
  collapsedTemplateIds: string[];
  users: ProjectUser[];
  usersLoading: boolean;
  onAdd: () => void;
  onRemove: (id: string) => void;
  onUpdate: (id: string, updates: Partial<TaskDefinition>) => void;
  onToggleCollapsed: (id: string) => void;
  onContinue: () => void;
  canContinue: boolean;
}) {
  return (
    <Card className="qa-card">
      <CardHeader>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle className="text-base">Task Templates</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              Each template creates one task under every selected story.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={onAdd}
            disabled={tasks.length >= MAX_TASK_TEMPLATES}
          >
            <Plus className="size-4" />
            Add Task
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-3">
          {tasks.map((task, index) => {
            const issues = taskIssuesById.get(task.id) ?? [];
            const valid = issues.length === 0;
            const collapsed = valid && collapsedTemplateIds.includes(task.id);
            return (
              <TaskTemplateCard
                key={task.id}
                task={task}
                index={index}
                issues={issues}
                collapsed={collapsed}
                canRemove={tasks.length > 1}
                users={users}
                usersLoading={usersLoading}
                onRemove={() => onRemove(task.id)}
                onUpdate={(updates) => onUpdate(task.id, updates)}
                onToggleCollapsed={() => onToggleCollapsed(task.id)}
              />
            );
          })}
        </div>

        <div className="flex flex-col-reverse gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted-foreground">
            At least one valid template is required to select target stories.
          </p>
          <Button type="button" onClick={onContinue} disabled={!canContinue}>
            Continue to Target Stories
            <ArrowRight className="size-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

type TemplateStatus = "valid" | "warning" | "invalid";

function templateTitleDisplay(index: number, title: string) {
  return `Task ${index + 1} · ${title.trim() || "Untitled task"}`;
}

// Display-only status. Must NOT affect the collapse gate, the Continue button,
// or blocking errors — those stay driven by buildTaskDefinitionIssues.
function templateStatus(issues: TaskDefinitionIssue[], task: TaskDefinition): TemplateStatus {
  if (issues.length > 0) return "invalid";
  if (!task.originalEstimate.trim() || !task.assignedTo.trim()) return "warning";
  return "valid";
}

function remainingWorkSummary(task: TaskDefinition) {
  return task.copyEstimateToRemainingWork ? "Equal to estimate" : "Estimate only";
}

// Compact one-line summary shown in both expanded and collapsed modes.
function templateSummary(task: TaskDefinition, users: ProjectUser[]) {
  const hasTitle = Boolean(task.title.trim());
  const hasEstimate = Boolean(task.originalEstimate.trim());
  const parts = [
    `Assignee: ${task.assignedTo.trim() ? projectAssigneeLabel(task.assignedTo, users) : "Unassigned"}`,
    `Estimate: ${hasEstimate ? `${task.originalEstimate.trim()}h` : "None"}`,
    `Remaining work: ${remainingWorkSummary(task)}`,
  ];
  if (!hasTitle) parts.push("Missing title");
  if (!hasEstimate) parts.push("Missing estimate");
  return parts.join(" · ");
}

function TemplateStatusBadge({ status }: { status: TemplateStatus }) {
  if (status === "invalid") return <Badge variant="destructive">Invalid</Badge>;
  if (status === "warning") {
    return (
      <Badge className="border-warning/40 bg-warning/15 text-warning-foreground dark:text-warning">
        Warning
      </Badge>
    );
  }
  return null;
}

function TaskTemplateCard({
  task,
  index,
  issues,
  collapsed,
  canRemove,
  users,
  usersLoading,
  onRemove,
  onUpdate,
  onToggleCollapsed,
}: {
  task: TaskDefinition;
  index: number;
  issues: TaskDefinitionIssue[];
  collapsed: boolean;
  canRemove: boolean;
  users: ProjectUser[];
  usersLoading: boolean;
  onRemove: () => void;
  onUpdate: (updates: Partial<TaskDefinition>) => void;
  onToggleCollapsed: () => void;
}) {
  const valid = issues.length === 0;
  const titleId = `task-template-${task.id}-title`;
  const descriptionId = `task-template-${task.id}-description`;
  const estimateId = `task-template-${task.id}-estimate`;
  const remainingWorkId = `task-template-${task.id}-remaining-work`;
  const titleErrorId = `${titleId}-error`;
  const estimateErrorId = `${estimateId}-error`;
  const titleIssue = issues.find((issue) => issue.field === "title");
  const estimateIssue = issues.find((issue) => issue.field === "estimate");
  const status = templateStatus(issues, task);
  const summary = templateSummary(task, users);

  return (
    <section
      className={cn(
        "overflow-hidden rounded-xl border bg-card",
        valid ? "border-border" : "border-destructive/40",
      )}
      aria-labelledby={`${titleId}-heading`}
    >
      <div className="flex flex-col gap-2 bg-muted/25 px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h3 id={`${titleId}-heading`} className="truncate font-semibold text-foreground">
              {templateTitleDisplay(index, task.title)}
            </h3>
            <TemplateStatusBadge status={status} />
          </div>
          <p className="truncate text-xs text-muted-foreground" title={summary}>
            {summary}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1">
          {valid ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-expanded={!collapsed}
              onClick={onToggleCollapsed}
            >
              <ChevronDown className={cn("size-4 transition-transform", !collapsed && "rotate-180")} />
              {collapsed ? "Expand" : "Collapse"}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onRemove}
            disabled={!canRemove}
            aria-label={`Remove task ${index + 1}`}
          >
            <Trash2 className="size-4" />
            Remove
          </Button>
        </div>
      </div>

      {!collapsed ? (
        <div className="p-4">
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div className="space-y-3">
              <Field label="Title" required htmlFor={titleId}>
                <Input
                  id={titleId}
                  value={task.title}
                  onChange={(event) => onUpdate({ title: event.target.value })}
                  placeholder="Task title"
                  aria-invalid={Boolean(titleIssue)}
                  aria-describedby={titleIssue ? titleErrorId : undefined}
                />
                {titleIssue ? (
                  <p id={titleErrorId} role="alert" className="text-xs text-destructive">
                    {titleIssue.message}
                  </p>
                ) : null}
              </Field>
              <Field label="Description" htmlFor={descriptionId}>
                <Textarea
                  id={descriptionId}
                  value={task.description}
                  onChange={(event) => onUpdate({ description: event.target.value })}
                  className="min-h-24"
                  placeholder="Optional description"
                />
              </Field>
            </div>

            <div className="space-y-3">
              <Field label="Default assignee">
                <ProjectUserPicker
                  mode="single"
                  value={task.assignedTo}
                  users={users}
                  loading={usersLoading}
                  onValueChange={(value) => onUpdate({ assignedTo: value })}
                  placeholder="No default assignee"
                  emptyOptionLabel="No default assignee"
                  contentClassName="w-[var(--radix-popover-trigger-width)]"
                  ariaLabel={`Default assignee for task ${index + 1}`}
                />
              </Field>
              <Field label="Default estimate (hours)" htmlFor={estimateId}>
                <Input
                  id={estimateId}
                  value={task.originalEstimate}
                  onChange={(event) => {
                    if (isAllowedEstimateInput(event.target.value)) {
                      onUpdate({ originalEstimate: event.target.value });
                    }
                  }}
                  inputMode="decimal"
                  pattern="(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?"
                  placeholder="Hours"
                  aria-invalid={Boolean(estimateIssue)}
                  aria-describedby={estimateIssue ? estimateErrorId : undefined}
                />
                {estimateIssue ? (
                  <p id={estimateErrorId} role="alert" className="text-xs text-destructive">
                    {estimateIssue.message}
                  </p>
                ) : null}
              </Field>
              <Label
                htmlFor={remainingWorkId}
                className="flex items-start gap-2.5 rounded-md border border-border bg-muted/20 px-3 py-2 text-sm"
              >
                <Checkbox
                  id={remainingWorkId}
                  checked={task.copyEstimateToRemainingWork}
                  onCheckedChange={(checked) =>
                    onUpdate({ copyEstimateToRemainingWork: checked === true })
                  }
                  className="mt-0.5"
                />
                <span className="min-w-0">
                  <span className="block font-medium text-foreground">
                    Set remaining work equal to estimate
                  </span>
                  <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                    Uses the final story override if available, otherwise this template estimate.
                  </span>
                </span>
              </Label>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function TargetStoriesStep({
  scope,
  targetMode,
  selectedCount,
  iterations,
  selectedIterationPath,
  selectedIteration,
  iterationsLoading,
  storiesLoading,
  stories,
  selectedStoryIds,
  selectedOnly,
  searchableStories,
  selectedSearchableStoryIds,
  searchableStoriesLoading,
  searchableStoriesError,
  onTargetModeChange,
  onIterationChange,
  onReloadIterations,
  onLoadStories,
  onToggleStory,
  onToggleAll,
  onSelectedOnlyChange,
  onSearchSelectionChange,
  onRetrySearch,
  onClearSelection,
  onBack,
  onReview,
  canReview,
}: {
  scope: ActiveProjectScope | null;
  targetMode: TargetMode;
  selectedCount: number;
  iterations: AzureIteration[];
  selectedIterationPath: string;
  selectedIteration?: AzureIteration;
  iterationsLoading: boolean;
  storiesLoading: boolean;
  stories: UserStory[];
  selectedStoryIds: string[];
  selectedOnly: boolean;
  searchableStories: UserStory[];
  selectedSearchableStoryIds: string[];
  searchableStoriesLoading: boolean;
  searchableStoriesError: string | null;
  onTargetModeChange: (value: TargetMode) => void;
  onIterationChange: (value: string) => void;
  onReloadIterations: () => void;
  onLoadStories: () => void;
  onToggleStory: (storyId: string, checked: boolean) => void;
  onToggleAll: (checked: boolean, storyIds?: string[]) => void;
  onSelectedOnlyChange: (value: boolean) => void;
  onSearchSelectionChange: (value: string[]) => void;
  onRetrySearch: () => void;
  onClearSelection: () => void;
  onBack: () => void;
  onReview: () => void;
  canReview: boolean;
}) {
  return (
    <Card className="qa-card">
      <CardHeader>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle className="text-base">Target Stories</CardTitle>
              <Badge variant="secondary">{selectedCount} selected</Badge>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Choose stories from a sprint or search across the active project.
            </p>
          </div>
          {selectedCount ? (
            <Button type="button" variant="outline" size="sm" onClick={onClearSelection}>
              Clear selection
            </Button>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <Tabs
          value={targetMode}
          onValueChange={(value) => onTargetModeChange(value as TargetMode)}
          className="flex-col gap-4"
        >
          <TabsList variant="primary" className="h-auto">
            <TabsTrigger value="iteration" className="h-10 px-4">
              Select by Sprint
            </TabsTrigger>
            <TabsTrigger value="manual" className="h-10 px-4">
              Search stories
            </TabsTrigger>
          </TabsList>

          <TabsContent value="iteration" className="space-y-4">
            <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto_auto] lg:items-end">
              <Field label="Iteration" htmlFor="bulk-task-iteration">
                <select
                  id="bulk-task-iteration"
                  className="focus-ring h-10 w-full rounded-md border border-input bg-card px-3 text-sm"
                  value={selectedIterationPath}
                  onChange={(event) => onIterationChange(event.target.value)}
                  disabled={!scope || iterationsLoading}
                >
                  <option value="">{iterationsLoading ? "Loading iterations..." : "Select iteration"}</option>
                  {iterations.map((iteration) => (
                    <option key={iteration.id} value={iteration.path}>
                      {iteration.path}
                    </option>
                  ))}
                </select>
              </Field>
              <Button
                type="button"
                variant="outline"
                onClick={onReloadIterations}
                disabled={!scope || iterationsLoading || storiesLoading}
              >
                {iterationsLoading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                Refresh
              </Button>
              <Button
                type="button"
                onClick={onLoadStories}
                disabled={!scope || !selectedIterationPath || storiesLoading || iterationsLoading}
              >
                {storiesLoading ? <Loader2 className="size-4 animate-spin" /> : <ClipboardList className="size-4" />}
                {storiesLoading ? "Loading Stories..." : "Load User Stories"}
              </Button>
            </div>

            {selectedIteration ? (
              <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                <Badge variant="outline">{selectedIteration.name}</Badge>
                {selectedIteration.startDate ? <Badge variant="secondary">Start {formatDate(selectedIteration.startDate)}</Badge> : null}
                {selectedIteration.finishDate ? <Badge variant="secondary">Finish {formatDate(selectedIteration.finishDate)}</Badge> : null}
              </div>
            ) : null}

            {stories.length ? (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-muted/25 px-3 py-2">
                <span className="text-sm text-muted-foreground">
                  {selectedStoryIds.length} of {stories.length} loaded stories selected
                </span>
                <Label htmlFor="selected-stories-only" className="flex items-center gap-2 text-sm font-medium">
                  <Switch
                    id="selected-stories-only"
                    checked={selectedOnly}
                    onCheckedChange={onSelectedOnlyChange}
                  />
                  Selected only
                </Label>
              </div>
            ) : null}

            <StorySelectionTable
              stories={stories}
              selectedStoryIds={selectedStoryIds}
              selectedOnly={selectedOnly}
              loading={storiesLoading}
              onToggleStory={onToggleStory}
              onToggleAll={onToggleAll}
            />
          </TabsContent>

          <TabsContent value="manual" className="space-y-3">
            <Field label="Stories">
              <SearchableMultiSelect
                options={searchableStories}
                value={selectedSearchableStoryIds}
                onValueChange={onSearchSelectionChange}
                getOptionValue={(story) => story.id}
                getOptionLabel={(story) => `${story.id} - ${story.title}`}
                getOptionSearchText={(story) => `${story.id} ${story.title}`}
                renderOption={(story) => (
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="shrink-0 font-mono text-xs font-semibold text-primary">{story.id}</span>
                      <span className="truncate text-sm font-medium text-foreground">{story.title}</span>
                    </div>
                    <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      {story.state ? <Badge variant="secondary">{story.state}</Badge> : null}
                      {story.assignedTo ? <span className="max-w-[180px] truncate">{story.assignedTo}</span> : null}
                      {story.iterationPath ? <span className="max-w-[240px] truncate">{story.iterationPath}</span> : null}
                    </div>
                  </div>
                )}
                loading={searchableStoriesLoading}
                error={searchableStoriesError}
                disabled={!scope}
                placeholder="Select user stories"
                loadingText="Loading user stories..."
                searchPlaceholder="Search by story name or ID"
                emptyMessage="No user stories match your search."
                ariaLabel="Select target user stories"
                triggerIcon={<Search className="size-4" />}
                contentClassName="w-[min(680px,calc(100vw-2rem))]"
                onRetry={onRetrySearch}
              />
            </Field>
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
              <span>Search the 200 most recently changed user stories in this project.</span>
              <Badge variant="secondary">{selectedSearchableStoryIds.length} selected</Badge>
            </div>
          </TabsContent>
        </Tabs>

        <div className="flex flex-col-reverse gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
          <Button type="button" variant="outline" onClick={onBack}>
            <ArrowLeft className="size-4" />
            Back to Templates
          </Button>
          <Button type="button" onClick={onReview} disabled={!canReview}>
            Review {selectedCount ? `${selectedCount} Stories` : "Selection"}
            <ArrowRight className="size-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Field({
  label,
  required,
  htmlFor,
  children,
}: {
  label: string;
  required?: boolean;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor} className="text-sm font-semibold text-foreground">
        {label}
        {required ? <span className="ml-1 text-destructive">*</span> : null}
      </Label>
      {children}
    </div>
  );
}

function StorySelectionTable({
  stories,
  selectedStoryIds,
  selectedOnly,
  loading,
  onToggleStory,
  onToggleAll,
}: {
  stories: UserStory[];
  selectedStoryIds: string[];
  selectedOnly: boolean;
  loading: boolean;
  onToggleStory: (storyId: string, checked: boolean) => void;
  onToggleAll: (checked: boolean, storyIds?: string[]) => void;
}) {
  const [sortKey, setSortKey] = useState<StorySortKey | null>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");

  const sortedStories = useMemo(() => {
    if (!sortKey) return stories;
    return stories
      .map((story, index) => ({ story, index }))
      .sort((left, right) => {
        const compared = compareStoryValues(left.story[sortKey], right.story[sortKey]);
        if (compared !== 0) return sortDirection === "asc" ? compared : -compared;
        return left.index - right.index;
      })
      .map(({ story }) => story);
  }, [sortDirection, sortKey, stories]);

  function toggleSort(nextSortKey: StorySortKey) {
    if (sortKey === nextSortKey) {
      setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(nextSortKey);
    setSortDirection("asc");
  }

  const visibleStories = selectedOnly
    ? sortedStories.filter((story) => selectedStoryIds.includes(story.id))
    : sortedStories;
  const allVisibleSelected = visibleStories.length > 0
    && visibleStories.every((story) => selectedStoryIds.includes(story.id));

  if (loading) {
    return (
      <div className="space-y-3 rounded-md border border-border bg-card p-4" aria-label="Loading user stories">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading user stories...
        </div>
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-10 w-full" />
        ))}
      </div>
    );
  }

  if (!stories.length) {
    return <div className="rounded-md border border-border bg-card p-5 text-sm text-muted-foreground">No user stories loaded.</div>;
  }

  if (!visibleStories.length) {
    return (
      <div className="rounded-md border border-border bg-card p-5 text-sm text-muted-foreground">
        No selected stories to display. Turn off Selected only to view all loaded stories.
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-10">
            <Checkbox
              checked={allVisibleSelected}
              onCheckedChange={(checked) =>
                onToggleAll(checked === true, visibleStories.map((story) => story.id))
              }
              aria-label="Select all visible stories"
            />
          </TableHead>
          <TableHead>ID</TableHead>
          <TableHead className="min-w-[320px]">Title</TableHead>
          <TableHead>
            <StorySortHeader
              label="State"
              active={sortKey === "state"}
              direction={sortDirection}
              onClick={() => toggleSort("state")}
            />
          </TableHead>
          <TableHead>
            <StorySortHeader
              label="Assignee"
              active={sortKey === "assignedTo"}
              direction={sortDirection}
              onClick={() => toggleSort("assignedTo")}
            />
          </TableHead>
          <TableHead>Iteration</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {visibleStories.map((story) => {
          const selected = selectedStoryIds.includes(story.id);
          return (
            <TableRow key={story.id} className={selected ? "qa-table-row-selected" : "qa-table-row"}>
              <TableCell>
                <Checkbox checked={selected} onCheckedChange={(checked) => onToggleStory(story.id, checked === true)} aria-label={`Select story ${story.id}`} />
              </TableCell>
              <TableCell className="font-mono text-xs font-semibold text-primary">{story.id}</TableCell>
              <TableCell className="min-w-[320px] whitespace-normal font-medium text-foreground">{story.title}</TableCell>
              <TableCell>{story.state ?? "-"}</TableCell>
              <TableCell className="max-w-[220px] truncate">{story.assignedTo ?? "-"}</TableCell>
              <TableCell className="max-w-[280px] truncate">{story.iterationPath ?? "-"}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function StorySortHeader({
  label,
  active,
  direction,
  onClick,
}: {
  label: string;
  active: boolean;
  direction: SortDirection;
  onClick: () => void;
}) {
  const Icon = active ? (direction === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="-ml-2 h-8 px-2 text-foreground"
      onClick={onClick}
      aria-label={`Sort by ${label} ${active && direction === "asc" ? "descending" : "ascending"}`}
      aria-sort={active ? (direction === "asc" ? "ascending" : "descending") : "none"}
    >
      {label}
      <Icon className="size-3.5" aria-hidden="true" />
      {active ? <span className="text-xs text-muted-foreground">{direction === "asc" ? "Asc" : "Desc"}</span> : null}
    </Button>
  );
}

function compareStoryValues(left?: string, right?: string) {
  const leftText = left?.trim();
  const rightText = right?.trim();

  if (!leftText && !rightText) return 0;
  if (!leftText) return 1;
  if (!rightText) return -1;

  return leftText.localeCompare(rightText, undefined, { numeric: true, sensitivity: "base" });
}

function ReviewCreateStep({
  rows,
  tasks,
  overrides,
  users,
  usersLoading,
  resultsByStoryId,
  expandedStoryIds,
  reviewWarnings,
  totalEstimatedHours,
  onExpandedStoryIdsChange,
  onOverrideChange,
  onBack,
}: {
  rows: TargetRow[];
  tasks: TaskDefinition[];
  overrides: Record<string, StoryTaskOverrides>;
  users: ProjectUser[];
  usersLoading: boolean;
  resultsByStoryId: Map<string, BulkTaskPairResult[]>;
  expandedStoryIds: string[];
  reviewWarnings: ReviewWarning[];
  totalEstimatedHours: number;
  onExpandedStoryIdsChange: (storyIds: string[]) => void;
  onOverrideChange: (
    storyId: string,
    templateId: string,
    field: keyof TaskOverrideValues,
    value: string,
  ) => void;
  onBack: () => void;
}) {
  return (
    <Card className="qa-card">
      <CardHeader>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle className="text-base">Review & Create</CardTitle>
              <Badge variant="outline">{tasks.length} templates</Badge>
              <Badge variant="outline">{rows.length} stories</Badge>
              <Badge variant="secondary">{tasks.length * rows.length} tasks</Badge>
              <Badge variant="outline">{formatHours(totalEstimatedHours)}h estimated</Badge>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Review effective values, apply per-template overrides, then create the batch.
            </p>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={onBack}>
            <ArrowLeft className="size-4" />
            Edit Stories
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-3">
          <div>
            <h3 className="font-semibold text-foreground">Stories and generated tasks</h3>
            <p className="text-sm text-muted-foreground">
              Expand a story to review or change each task independently.
            </p>
          </div>
          <StoryReviewAccordion
            rows={rows}
            tasks={tasks}
            overrides={overrides}
            users={users}
            usersLoading={usersLoading}
            resultsByStoryId={resultsByStoryId}
            expandedStoryIds={expandedStoryIds}
            reviewWarnings={reviewWarnings}
            onExpandedStoryIdsChange={onExpandedStoryIdsChange}
            onOverrideChange={onOverrideChange}
          />
        </div>
      </CardContent>
    </Card>
  );
}

function StoryReviewAccordion({
  rows,
  tasks,
  overrides,
  users,
  usersLoading,
  resultsByStoryId,
  expandedStoryIds,
  reviewWarnings,
  onExpandedStoryIdsChange,
  onOverrideChange,
}: {
  rows: TargetRow[];
  tasks: TaskDefinition[];
  overrides: Record<string, StoryTaskOverrides>;
  users: ProjectUser[];
  usersLoading: boolean;
  resultsByStoryId: Map<string, BulkTaskPairResult[]>;
  expandedStoryIds: string[];
  reviewWarnings: ReviewWarning[];
  onExpandedStoryIdsChange: (storyIds: string[]) => void;
  onOverrideChange: (
    storyId: string,
    templateId: string,
    field: keyof TaskOverrideValues,
    value: string,
  ) => void;
}) {
  if (!rows.length) {
    return (
      <div className="rounded-md border border-border bg-card p-5 text-sm text-muted-foreground">
        No target stories selected.
      </div>
    );
  }

  return (
    <Accordion
      type="multiple"
      value={expandedStoryIds}
      onValueChange={onExpandedStoryIdsChange}
      className="space-y-2"
    >
      {rows.map((row) => {
        const storyOverrides = overrides[row.storyId] ?? {};
        const storyResults = resultsByStoryId.get(row.storyId);
        const storyWarnings = reviewWarnings.filter((warning) => warning.storyId === row.storyId);
        const totalEstimate = calculateStoryEstimatedHours(row, tasks, overrides);
        return (
          <AccordionItem
            key={row.key}
            value={row.storyId}
            className={cn(
              storyWarnings.length && "border-warning/50",
              storyResults?.some((item) => item.status === "failed") && "border-destructive/50",
            )}
          >
            <AccordionTrigger className="items-start">
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="shrink-0 font-mono text-xs font-semibold text-primary">
                    {row.storyId}
                  </span>
                  <span className="min-w-0 truncate font-semibold text-foreground">
                    {row.title ?? "Target story"}
                  </span>
                  {row.state ? <Badge variant="secondary">{row.state}</Badge> : null}
                  <StoryResultBadge results={storyResults} taskDefinitionCount={tasks.length} />
                </div>
                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs font-normal text-muted-foreground">
                  <span>{tasks.length} task{tasks.length === 1 ? "" : "s"}</span>
                  <span>{formatHours(totalEstimate)}h total</span>
                  {storyWarnings.length ? (
                    <span className="font-medium text-warning-foreground dark:text-warning">
                      {storyWarnings.length} warning{storyWarnings.length === 1 ? "" : "s"}
                    </span>
                  ) : (
                    <span className="font-medium text-success">No issues</span>
                  )}
                </div>
              </div>
            </AccordionTrigger>
            <AccordionContent>
              <div className="space-y-3">
                {storyWarnings.length ? (
                  <Callout tone="warning">
                    <ul className="list-disc space-y-0.5 pl-4">
                      {storyWarnings.map((warning) => (
                        <li key={`${warning.templateId}-${warning.message}`}>{warning.message}</li>
                      ))}
                    </ul>
                  </Callout>
                ) : null}
                {tasks.map((task, index) => (
                  <ReviewTaskCard
                    key={task.id}
                    task={task}
                    index={index}
                    storyId={row.storyId}
                    taskOverride={storyOverrides[task.id]}
                    users={users}
                    usersLoading={usersLoading}
                    result={storyResults?.find((item) => item.templateId === task.id)}
                    onChange={onOverrideChange}
                  />
                ))}
              </div>
            </AccordionContent>
          </AccordionItem>
        );
      })}
    </Accordion>
  );
}

function ReviewTaskCard({
  task,
  index,
  storyId,
  taskOverride,
  users,
  usersLoading,
  result,
  onChange,
}: {
  task: TaskDefinition;
  index: number;
  storyId: string;
  taskOverride?: TaskOverrideValues;
  users: ProjectUser[];
  usersLoading: boolean;
  result?: BulkTaskPairResult;
  onChange: (
    storyId: string,
    templateId: string,
    field: keyof TaskOverrideValues,
    value: string,
  ) => void;
}) {
  const override = taskOverride ?? { assignedTo: "", originalEstimate: "" };
  const effectiveAssignee = getEffectiveTaskValue(task, override, "assignedTo");
  const effectiveEstimate = getEffectiveTaskValue(task, override, "originalEstimate");
  const hasAssigneeOverride = Boolean(override.assignedTo.trim());
  const hasEstimateOverride = Boolean(override.originalEstimate.trim());
  const estimateId = `story-${storyId}-task-${task.id}-estimate`;
  const estimateWarningId = `${estimateId}-warning`;

  const effectiveAssigneeLabel = effectiveAssignee
    ? projectAssigneeLabel(effectiveAssignee, users)
    : "Unassigned";
  const effectiveEstimateLabel = formatEstimateLabel(effectiveEstimate) ?? "Not set";

  const assigneeWarning = effectiveAssignee
    ? null
    : { message: "Missing assignee", tone: "warning" as const };
  const estimateFormatError = validateEstimate(override.originalEstimate, "Estimate");
  const estimateWarning = estimateFormatError
    ? { message: estimateFormatError, tone: "error" as const }
    : effectiveEstimate
      ? null
      : { message: "Missing estimate", tone: "warning" as const };
  const hasError = Boolean(estimateFormatError) || result?.status === "failed";

  const remainingWorkMessage = task.copyEstimateToRemainingWork
    ? effectiveEstimate
      ? `Remaining work will be set to ${formatEstimateLabel(effectiveEstimate)}.`
      : "Remaining work will be set once an estimate is provided."
    : "Remaining work will not be changed from the estimate.";

  const summary = [
    `Assignee: ${effectiveAssigneeLabel}`,
    `Estimate: ${effectiveEstimate ? `${effectiveEstimate}h` : "Not set"}`,
    `Remaining: ${
      task.copyEstimateToRemainingWork
        ? effectiveEstimate
          ? `${effectiveEstimate}h`
          : "Pending"
        : "Unchanged"
    }`,
  ].join(" · ");

  return (
    <section
      className={cn(
        "rounded-lg border bg-muted/20 p-3",
        hasError ? "border-destructive/40" : "border-border",
      )}
      aria-label={`Task ${index + 1}: ${task.title.trim() || "Untitled task"}`}
    >
      <header className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Badge variant="outline">Task {index + 1}</Badge>
            <h4 className="min-w-0 truncate font-semibold text-foreground">
              {task.title.trim() || "Untitled task"}
            </h4>
          </div>
          <p className="mt-1 truncate text-xs text-muted-foreground" title={summary}>
            {summary}
          </p>
          {task.description.trim() ? (
            <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">
              {task.description.trim()}
            </p>
          ) : null}
        </div>
        <TaskPairResultBadge result={result} />
      </header>

      <div className="mt-3 grid gap-x-4 gap-y-3 sm:grid-cols-[minmax(0,1fr)_minmax(150px,190px)]">
        <div className="space-y-1.5">
          <Label className="text-xs font-medium text-muted-foreground">Assignee</Label>
          <ProjectUserPicker
            mode="single"
            value={override.assignedTo}
            users={users}
            loading={usersLoading}
            onValueChange={(value) => onChange(storyId, task.id, "assignedTo", value)}
            placeholder="Use template default"
            emptyOptionLabel="Use template default"
            contentClassName="w-[var(--radix-popover-trigger-width)]"
            ariaLabel={`Assignee for task ${index + 1} in story ${storyId}`}
          />
          <ReviewFieldMeta
            effective={effectiveAssigneeLabel}
            isOverridden={hasAssigneeOverride}
            warning={assigneeWarning}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={estimateId} className="text-xs font-medium text-muted-foreground">
            Estimate (hours)
          </Label>
          <Input
            id={estimateId}
            value={override.originalEstimate}
            onChange={(event) => {
              if (isAllowedEstimateInput(event.target.value)) {
                onChange(storyId, task.id, "originalEstimate", event.target.value);
              }
            }}
            inputMode="decimal"
            pattern="(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?"
            placeholder={task.originalEstimate || "Use template default"}
            aria-invalid={Boolean(estimateFormatError)}
            aria-describedby={estimateWarning ? estimateWarningId : undefined}
          />
          <ReviewFieldMeta
            effective={effectiveEstimateLabel}
            isOverridden={hasEstimateOverride}
            warning={estimateWarning}
            warningId={estimateWarningId}
          />
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2 rounded-md bg-muted/50 px-2.5 py-1.5 text-xs text-muted-foreground">
        <Info className="size-3.5 shrink-0" aria-hidden="true" />
        <span>{remainingWorkMessage}</span>
      </div>
    </section>
  );
}

function ReviewFieldMeta({
  effective,
  isOverridden,
  warning,
  warningId,
}: {
  effective: string;
  isOverridden: boolean;
  warning: { message: string; tone: "warning" | "error" } | null;
  warningId?: string;
}) {
  return (
    <div className="space-y-1 text-xs">
      <div className="min-w-0 text-muted-foreground">
        <span className="block truncate" title={isOverridden ? "Overridden" : effective}>
          <span className="font-medium text-foreground">Effective:</span>{" "}
          {isOverridden ? "Overridden" : effective}
        </span>
      </div>
      {warning ? (
        <p
          id={warningId}
          className={cn(
            "flex items-center gap-1 font-medium",
            warning.tone === "error"
              ? "text-destructive"
              : "text-warning-foreground dark:text-warning",
          )}
        >
          <TriangleAlert className="size-3 shrink-0" aria-hidden="true" />
          <span>{warning.message}</span>
        </p>
      ) : null}
    </div>
  );
}

function TaskPairResultBadge({ result }: { result?: BulkTaskPairResult }) {
  if (!result) return <Badge variant="outline">Pending</Badge>;
  if (result.status === "created") {
    return <Badge className="bg-success text-success-foreground">Created #{result.taskId}</Badge>;
  }
  if (result.status === "skipped") {
    return <Badge className="bg-warning text-warning-foreground">Skipped</Badge>;
  }
  return <Badge variant="destructive">Failed</Badge>;
}

function projectAssigneeLabel(value: string, users: ProjectUser[]) {
  const user = users.find((candidate) => projectUserValue(candidate) === value);
  return user ? projectUserLabel(user) : value;
}

function StoryResultBadge({
  results,
  taskDefinitionCount,
}: {
  results?: BulkTaskPairResult[];
  taskDefinitionCount: number;
}) {
  if (!results?.length) return <Badge variant="outline">Pending</Badge>;

  const created = results.filter((result) => result.status === "created").length;
  const skipped = results.filter((result) => result.status === "skipped").length;
  const failed = results.filter((result) => result.status === "failed").length;

  if (failed) {
    return <Badge variant="destructive">{created} created, {failed} failed</Badge>;
  }
  if (skipped) {
    return <Badge className="bg-warning text-warning-foreground">{created} created, {skipped} skipped</Badge>;
  }
  if (created === taskDefinitionCount) {
    return <Badge className="bg-success text-success-foreground">{created}/{taskDefinitionCount} created</Badge>;
  }
  return <Badge variant="outline">{results.length}/{taskDefinitionCount} processed</Badge>;
}

function ResultPanel({ result }: { result: BulkTaskResponse }) {
  return (
    <Card className="qa-card">
      <CardHeader>
        <CardTitle className="text-base">Result</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard label="Requested" value={result.requestedCount} />
          <StatCard label="Created" value={result.created.length} tone="success" />
          <StatCard label="Skipped" value={result.skipped.length} tone={result.skipped.length ? "warning" : "neutral"} />
          <StatCard label="Failed" value={result.failed.length} tone={result.failed.length ? "error" : "neutral"} />
        </div>

        <div className="grid gap-4 xl:grid-cols-3">
          <div className="rounded-md border border-border bg-card">
            <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-sm font-semibold text-foreground">
              <CheckCircle2 className="size-4 text-success" />
              Created tasks
            </div>
            <div className="divide-y divide-border">
              {result.created.length ? result.created.map((item) => (
                <div key={`${item.storyId}-${item.taskId}`} className="grid gap-1 px-3 py-2 text-sm sm:grid-cols-[110px_1fr]">
                  <span className="font-mono text-xs font-semibold text-primary">Story {item.storyId}</span>
                  <span>Task {item.taskId}: {item.title}</span>
                </div>
              )) : <div className="px-3 py-4 text-sm text-muted-foreground">No tasks created.</div>}
            </div>
          </div>

          <div className="rounded-md border border-border bg-card">
            <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-sm font-semibold text-foreground">
              <ClipboardList className="size-4 text-warning" />
              Skipped tasks
            </div>
            <div className="divide-y divide-border">
              {result.skipped.length ? result.skipped.map((item) => (
                <div key={`${item.templateId}-${item.storyId}`} className="grid gap-1 px-3 py-2 text-sm sm:grid-cols-[110px_1fr]">
                  <span className="font-mono text-xs font-semibold text-primary">Story {item.storyId}</span>
                  <span>{item.title}: {item.error}</span>
                </div>
              )) : <div className="px-3 py-4 text-sm text-muted-foreground">No skipped tasks.</div>}
            </div>
          </div>

          <div className="rounded-md border border-border bg-card">
            <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-sm font-semibold text-foreground">
              <XCircle className="size-4 text-destructive" />
              Failed tasks
            </div>
            <div className="divide-y divide-border">
              {result.failed.length ? result.failed.map((item) => (
                <div key={`${item.templateId}-${item.storyId}`} className="grid gap-1 px-3 py-2 text-sm sm:grid-cols-[110px_1fr]">
                  <span className="font-mono text-xs font-semibold text-primary">Story {item.storyId}</span>
                  <span>{item.title}: {item.error}</span>
                </div>
              )) : <div className="px-3 py-4 text-sm text-muted-foreground">No failures.</div>}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function buildTaskDefinitionIssues(tasks: TaskDefinition[]) {
  const issuesById = new Map<string, TaskDefinitionIssue[]>();
  const addIssue = (taskId: string, issue: TaskDefinitionIssue) => {
    issuesById.set(taskId, [...(issuesById.get(taskId) ?? []), issue]);
  };

  tasks.forEach((task, index) => {
    if (!task.title.trim()) {
      addIssue(task.id, {
        field: "title",
        message: "Title is required",
        summary: `Task ${index + 1} title is required.`,
      });
    }
    const estimateError = validateEstimate(
      task.originalEstimate,
      `Default estimate for task ${index + 1}`,
    );
    if (estimateError) {
      addIssue(task.id, {
        field: "estimate",
        message: "Enter a valid number of hours",
        summary: estimateError,
      });
    }
  });

  const tasksByTitle = new Map<string, TaskDefinition[]>();
  tasks.forEach((task) => {
    const normalizedTitle = normalizeTitleForMatch(task.title);
    if (!normalizedTitle) return;
    tasksByTitle.set(normalizedTitle, [...(tasksByTitle.get(normalizedTitle) ?? []), task]);
  });
  tasksByTitle.forEach((matchingTasks) => {
    if (matchingTasks.length < 2) return;
    matchingTasks.forEach((task) => {
      addIssue(task.id, {
        field: "title",
        message: "Title is duplicated",
        summary: `Task title "${task.title.trim()}" is duplicated.`,
      });
    });
  });

  return issuesById;
}

function buildBlockingErrors({
  scope,
  taskDefinitions,
  taskIssuesById,
  targetRows,
  overrides,
  requestedCount,
  result,
}: {
  scope: ActiveProjectScope | null;
  taskDefinitions: TaskDefinition[];
  taskIssuesById: Map<string, TaskDefinitionIssue[]>;
  targetRows: TargetRow[];
  overrides: Record<string, StoryTaskOverrides>;
  requestedCount: number;
  result: BulkTaskResponse | null;
}) {
  const errors: string[] = [];
  if (!scope) errors.push("Select an Azure DevOps project before creating tasks.");
  if (!taskDefinitions.length) errors.push("Add at least one task template.");
  if (taskDefinitions.length > MAX_TASK_TEMPLATES) {
    errors.push(`No more than ${MAX_TASK_TEMPLATES} task templates are allowed.`);
  }
  taskDefinitions.forEach((task) => {
    errors.push(...(taskIssuesById.get(task.id) ?? []).map((issue) => issue.summary));
  });
  if (!targetRows.length) errors.push("Select at least one target story.");
  if (requestedCount > MAX_TASK_CREATIONS) {
    errors.push(
      `This batch would create ${requestedCount} tasks. The maximum is ${MAX_TASK_CREATIONS}.`,
    );
  }

  const seenStoryIds = new Set<string>();
  targetRows.forEach((row) => {
    if (seenStoryIds.has(row.storyId)) errors.push(`Duplicate story ID ${row.storyId}.`);
    seenStoryIds.add(row.storyId);
    taskDefinitions.forEach((task, index) => {
      const estimateError = validateEstimate(
        overrides[row.storyId]?.[task.id]?.originalEstimate,
        `Estimate for task ${index + 1} in story ${row.storyId}`,
      );
      if (estimateError) errors.push(estimateError);
    });
  });

  if (result && result.requestedCount !== requestedCount) {
    errors.push(
      `The result count (${result.requestedCount}) does not match the current generated task count (${requestedCount}).`,
    );
  }
  if (result && result.results.length !== result.requestedCount) {
    errors.push(
      `Azure DevOps returned ${result.results.length} task results for ${result.requestedCount} requested tasks.`,
    );
  }

  return [...new Set(errors)];
}

function buildReviewWarnings(
  rows: TargetRow[],
  tasks: TaskDefinition[],
  overrides: Record<string, StoryTaskOverrides>,
) {
  const warnings: ReviewWarning[] = [];
  rows.forEach((row) => {
    tasks.forEach((task, index) => {
      const taskOverride = overrides[row.storyId]?.[task.id];
      const effectiveAssignee = getEffectiveTaskValue(task, taskOverride, "assignedTo");
      const effectiveEstimate = getEffectiveTaskValue(task, taskOverride, "originalEstimate");
      const taskLabel = task.title.trim() || `Task ${index + 1}`;
      if (!effectiveAssignee) {
        warnings.push({
          storyId: row.storyId,
          templateId: task.id,
          message: `${taskLabel} has no assignee.`,
        });
      }
      if (!effectiveEstimate) {
        warnings.push({
          storyId: row.storyId,
          templateId: task.id,
          message: `${taskLabel} has no estimate.`,
        });
      }
    });
  });
  return warnings;
}

function calculateTotalEstimatedHours(
  rows: TargetRow[],
  tasks: TaskDefinition[],
  overrides: Record<string, StoryTaskOverrides>,
) {
  return rows.reduce(
    (total, row) => total + calculateStoryEstimatedHours(row, tasks, overrides),
    0,
  );
}

function calculateStoryEstimatedHours(
  row: TargetRow,
  tasks: TaskDefinition[],
  overrides: Record<string, StoryTaskOverrides>,
) {
  return tasks.reduce((total, task) => {
    const estimate = getEffectiveTaskValue(
      task,
      overrides[row.storyId]?.[task.id],
      "originalEstimate",
    );
    if (!estimate || validateEstimate(estimate, "Estimate")) return total;
    return total + Number(estimate);
  }, 0);
}

function getEffectiveTaskValue(
  task: TaskDefinition,
  taskOverride: TaskOverrideValues | undefined,
  field: keyof TaskOverrideValues,
) {
  const overrideValue = taskOverride?.[field]?.trim();
  return overrideValue || task[field].trim();
}

function formatHours(value: number) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
}

function formatEstimateLabel(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return `${trimmed} hours`;
  return `${trimmed} hour${parsed === 1 ? "" : "s"}`;
}

function createEmptyTaskDefinition(): TaskDefinition {
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    title: "",
    description: "",
    assignedTo: "",
    originalEstimate: "",
    copyEstimateToRemainingWork: true,
  };
}

function optionalText(value?: string) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseOptionalEstimate(value?: string) {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return Number(trimmed);
}

function validateEstimate(value: string | undefined, label: string) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (!isValidEstimateText(trimmed)) return `${label} must be a non-negative whole number or decimal.`;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return `${label} must be a valid number.`;
  if (parsed < 0) return `${label} cannot be negative.`;
  return null;
}

function isAllowedEstimateInput(value: string) {
  return value === "" || /^\d*\.?\d*$/.test(value);
}

function isValidEstimateText(value: string) {
  return /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value);
}

function normalizeTitleForMatch(value: string) {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function findDefaultIterationPath(iterations: AzureIteration[]) {
  const now = new Date();
  const currentIterations = iterations.filter((iteration) => isCurrentIteration(iteration, now));
  if (currentIterations.length) {
    return currentIterations.sort((a, b) => b.path.length - a.path.length)[0].path;
  }

  const startedIterations = iterations
    .filter((iteration) => iteration.startDate && startOfLocalDay(iteration.startDate).getTime() <= now.getTime())
    .sort((a, b) => startOfLocalDay(b.startDate).getTime() - startOfLocalDay(a.startDate).getTime());
  return startedIterations[0]?.path ?? iterations[0]?.path ?? "";
}

function isCurrentIteration(iteration: AzureIteration, now: Date) {
  if (!iteration.startDate || !iteration.finishDate) return false;
  return startOfLocalDay(iteration.startDate).getTime() <= now.getTime() && now.getTime() <= endOfLocalDay(iteration.finishDate).getTime();
}

function startOfLocalDay(value?: string) {
  const date = value ? new Date(value) : new Date(0);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function endOfLocalDay(value?: string) {
  const start = startOfLocalDay(value);
  return new Date(start.getFullYear(), start.getMonth(), start.getDate(), 23, 59, 59, 999);
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
}
