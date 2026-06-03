"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowDown, ArrowUp, ArrowUpDown, CheckCircle2, ClipboardList, Loader2, RefreshCw, Send, XCircle } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { readActiveProject, type ActiveProjectScope } from "@/shared/lib/active-project";

type TargetMode = "iteration" | "manual";
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

type ProjectUser = {
  id: string;
  displayName: string;
  uniqueName?: string;
  imageUrl?: string;
};

type TargetRow = {
  key: string;
  storyId: string;
  title?: string;
  state?: string;
  assignedTo?: string;
  iterationPath?: string;
};

type BulkTaskResponse = {
  requestedCount: number;
  created: Array<{ storyId: string; taskId: string; title: string }>;
  failed: Array<{ storyId: string; error: string; status: "failed" | "skipped" }>;
  results: Array<{ storyId: string; status: "created" | "failed" | "skipped"; taskId?: string; error?: string }>;
};

type OverrideValues = {
  assignedTo: string;
  originalEstimate: string;
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

export function BulkTaskClient() {
  const [scope, setScope] = useState<ActiveProjectScope | null>(null);
  const [targetMode, setTargetMode] = useState<TargetMode>("iteration");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [defaultAssignedTo, setDefaultAssignedTo] = useState("");
  const [defaultEstimate, setDefaultEstimate] = useState("");
  const [copyEstimateToRemainingWork, setCopyEstimateToRemainingWork] = useState(true);
  const [iterations, setIterations] = useState<AzureIteration[]>([]);
  const [projectUsers, setProjectUsers] = useState<ProjectUser[]>([]);
  const [selectedIterationPath, setSelectedIterationPath] = useState("");
  const [iterationsLoading, setIterationsLoading] = useState(false);
  const [usersLoading, setUsersLoading] = useState(false);
  const [storiesLoading, setStoriesLoading] = useState(false);
  const [stories, setStories] = useState<UserStory[]>([]);
  const [selectedStoryIds, setSelectedStoryIds] = useState<string[]>([]);
  const [manualIds, setManualIds] = useState("");
  const [overrides, setOverrides] = useState<Record<string, OverrideValues>>({});
  const [submitLoading, setSubmitLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BulkTaskResponse | null>(null);

  useEffect(() => {
    setScope(readActiveProject());
    const onChange = (event: Event) => {
      const custom = event as CustomEvent<ActiveProjectScope>;
      setScope(custom.detail ?? readActiveProject());
      setStories([]);
      setProjectUsers([]);
      setSelectedStoryIds([]);
      setSelectedIterationPath("");
      setDefaultAssignedTo("");
      setOverrides({});
      setResult(null);
      setError(null);
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

  const manualParse = useMemo(() => parseManualIds(manualIds), [manualIds]);
  const targetRows = useMemo<TargetRow[]>(() => {
    if (targetMode === "manual") {
      return manualParse.ids.map((storyId, index) => ({ key: `manual-${storyId}-${index}`, storyId }));
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
  }, [manualParse.ids, selectedStoryIds, stories, targetMode]);

  const resultByStoryId = useMemo(() => {
    const map = new Map<string, BulkTaskResponse["results"][number]>();
    result?.results.forEach((item) => map.set(item.storyId, item));
    return map;
  }, [result]);

  const selectedIteration = iterations.find((iteration) => iteration.path === selectedIterationPath);
  const allLoadedSelected = stories.length > 0 && stories.every((story) => selectedStoryIds.includes(story.id));

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
    setResult(null);
    setSelectedStoryIds((current) => checked ? [...new Set([...current, storyId])] : current.filter((id) => id !== storyId));
  }

  function toggleAllStories(checked: boolean) {
    setResult(null);
    if (checked) {
      setSelectedStoryIds((current) => [...new Set([...current, ...stories.map((story) => story.id)])]);
      return;
    }
    const loadedIds = new Set(stories.map((story) => story.id));
    setSelectedStoryIds((current) => current.filter((id) => !loadedIds.has(id)));
  }

  function updateOverride(storyId: string, field: keyof OverrideValues, value: string) {
    setResult(null);
    setOverrides((current) => ({
      ...current,
      [storyId]: {
        assignedTo: current[storyId]?.assignedTo ?? "",
        originalEstimate: current[storyId]?.originalEstimate ?? "",
        [field]: value,
      },
    }));
  }

  function updateDefaultEstimate(value: string) {
    if (!isAllowedEstimateInput(value)) return;
    setDefaultEstimate(value);
    setResult(null);
  }

  async function submit() {
    const validationError = validateSubmit();
    if (validationError) {
      setError(validationError);
      toast.error(validationError);
      return;
    }
    if (!scope) return;

    const tasks = targetRows.map((row) => {
      const rowOverride = overrides[row.storyId];
      return {
        storyId: row.storyId,
        assignedTo: optionalText(rowOverride?.assignedTo),
        originalEstimate: parseOptionalEstimate(rowOverride?.originalEstimate),
      };
    });

    setSubmitLoading(true);
    setError(null);
    setResult(null);
    try {
      const data = await postJson<BulkTaskResponse>("/api/azure-devops/bulk-tasks", {
        scope,
        template: {
          title: title.trim(),
          description: optionalText(description),
          assignedTo: optionalText(defaultAssignedTo),
          originalEstimate: parseOptionalEstimate(defaultEstimate),
          copyEstimateToRemainingWork,
        },
        tasks,
      });
      setResult(data);
      toast.success(`Created ${data.created.length} of ${data.requestedCount} tasks.`);
    } catch (submitError) {
      const message = submitError instanceof Error ? submitError.message : "Azure DevOps bulk task creation failed.";
      setError(message);
      toast.error(message);
    } finally {
      setSubmitLoading(false);
    }
  }

  function validateSubmit() {
    if (!scope) return "Select an Azure DevOps project before creating tasks.";
    if (!title.trim()) return "Task title is required.";
    const defaultEstimateError = validateEstimate(defaultEstimate, "Default original estimate");
    if (defaultEstimateError) return defaultEstimateError;
    if (targetMode === "manual") {
      if (manualParse.invalid.length) return `Invalid IDs: ${manualParse.invalid.join(", ")}.`;
      if (manualParse.duplicates.length) return `Duplicate IDs: ${manualParse.duplicates.join(", ")}.`;
    }
    if (!targetRows.length) return "Select at least one target story.";

    const seen = new Set<string>();
    for (const row of targetRows) {
      if (seen.has(row.storyId)) return `Duplicate story ID ${row.storyId}.`;
      seen.add(row.storyId);
      const rowEstimateError = validateEstimate(overrides[row.storyId]?.originalEstimate, `Estimate for ${row.storyId}`);
      if (rowEstimateError) return rowEstimateError;
    }

    return null;
  }

  const canSubmit = Boolean(scope) && targetRows.length > 0 && !submitLoading;

  return (
    <div className="space-y-4">
      {!scope ? (
        <div className="flex items-center gap-2 rounded-md border border-[#F5CD47]/60 bg-[#FFF7D6] p-3 text-sm text-[#7F5F01]">
          <AlertTriangle className="size-4" />
          Select an Azure DevOps project before creating tasks.
        </div>
      ) : null}

      {error ? (
        <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-700">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      <Card className="qa-card">
        <CardHeader>
          <CardTitle className="text-base">Task Template</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="space-y-3">
            <Field label="Title" required>
              <Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Task title" aria-invalid={!title.trim()} />
            </Field>
            <Field label="Description">
              <Textarea value={description} onChange={(event) => setDescription(event.target.value)} className="min-h-28" placeholder="Optional description" />
            </Field>
          </div>
          <div className="space-y-3">
            <Field label="Default assignee">
              <AssigneeSelect
                value={defaultAssignedTo}
                users={projectUsers}
                loading={usersLoading}
                onChange={setDefaultAssignedTo}
                placeholder="No default assignee"
              />
            </Field>
            <Field label="Default original estimate">
              <Input
                value={defaultEstimate}
                onChange={(event) => updateDefaultEstimate(event.target.value)}
                inputMode="decimal"
                pattern="(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?"
                placeholder="Hours"
              />
            </Field>
            <Label className="flex items-start gap-3 rounded-md border border-[#DCDFE4] bg-white p-3 text-sm">
              <Checkbox
                checked={copyEstimateToRemainingWork}
                onCheckedChange={(checked) => setCopyEstimateToRemainingWork(checked === true)}
                className="mt-0.5"
              />
              <span>
                <span className="block font-semibold text-[#172B4D]">Set remaining work from estimate</span>
                <span className="mt-0.5 block text-xs leading-5 text-[#626F86]">
                  Uses the final row/default estimate when creating each task.
                </span>
              </span>
            </Label>
          </div>
        </CardContent>
      </Card>

      <Card className="qa-card">
        <CardHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <CardTitle className="text-base">Target Stories</CardTitle>
            <Badge variant="secondary">{targetRows.length} selected</Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <Tabs value={targetMode} onValueChange={(value) => { setTargetMode(value as TargetMode); setResult(null); }} className="flex-col gap-4">
            <TabsList className="h-auto rounded-md border border-[#DCDFE4] bg-[#F7F8F9] p-1">
              <TabsTrigger
                value="iteration"
                className="h-10 px-4 text-[#44546F] data-active:bg-[#0C66E4] data-active:font-semibold data-active:text-white data-active:shadow-sm data-[state=active]:bg-[#0C66E4] data-[state=active]:font-semibold data-[state=active]:text-white data-[state=active]:shadow-sm"
              >
                Pick from list
              </TabsTrigger>
              <TabsTrigger
                value="manual"
                className="h-10 px-4 text-[#44546F] data-active:bg-[#0C66E4] data-active:font-semibold data-active:text-white data-active:shadow-sm data-[state=active]:bg-[#0C66E4] data-[state=active]:font-semibold data-[state=active]:text-white data-[state=active]:shadow-sm"
              >
                Enter IDs
              </TabsTrigger>
            </TabsList>

            <TabsContent value="iteration" className="space-y-4">
              <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto_auto] lg:items-end">
                <Field label="Iteration">
                  <select
                    className="focus-ring h-10 w-full rounded-md border border-input bg-white px-3 text-sm"
                    value={selectedIterationPath}
                    onChange={(event) => setSelectedIterationPath(event.target.value)}
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
                <Button variant="outline" onClick={reloadIterations} disabled={!scope || iterationsLoading}>
                  {iterationsLoading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                  Refresh
                </Button>
                <Button onClick={loadStories} disabled={!scope || !selectedIterationPath || storiesLoading}>
                  {storiesLoading ? <Loader2 className="size-4 animate-spin" /> : <ClipboardList className="size-4" />}
                  Load User Stories
                </Button>
              </div>

              {selectedIteration ? (
                <div className="flex flex-wrap gap-2 text-xs text-[#626F86]">
                  <Badge variant="outline">{selectedIteration.name}</Badge>
                  {selectedIteration.startDate ? <Badge variant="secondary">Start {formatDate(selectedIteration.startDate)}</Badge> : null}
                  {selectedIteration.finishDate ? <Badge variant="secondary">Finish {formatDate(selectedIteration.finishDate)}</Badge> : null}
                </div>
              ) : null}

              <StorySelectionTable
                stories={stories}
                selectedStoryIds={selectedStoryIds}
                allLoadedSelected={allLoadedSelected}
                loading={storiesLoading}
                onToggleStory={toggleStory}
                onToggleAll={toggleAllStories}
              />
            </TabsContent>

            <TabsContent value="manual" className="space-y-3">
              <Field label="Story IDs">
                <Textarea
                  value={manualIds}
                  onChange={(event) => {
                    setManualIds(event.target.value);
                    setResult(null);
                  }}
                  className="min-h-32 font-mono text-sm"
                  placeholder="1234, 1235; 1236 1237"
                />
              </Field>
              <div className="flex flex-wrap gap-2 text-sm">
                <Badge variant="secondary">{manualParse.ids.length} IDs</Badge>
                {manualParse.invalid.length ? <Badge variant="destructive">Invalid: {manualParse.invalid.join(", ")}</Badge> : null}
                {manualParse.duplicates.length ? <Badge variant="destructive">Duplicates: {manualParse.duplicates.join(", ")}</Badge> : null}
              </div>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      <Card className="qa-card">
        <CardHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <CardTitle className="text-base">Overrides</CardTitle>
            <Button onClick={submit} disabled={!canSubmit}>
              {submitLoading ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
              {submitLoading ? "Creating..." : "Create Tasks"}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <TargetOverrideTable
            rows={targetRows}
            overrides={overrides}
            users={projectUsers}
            usersLoading={usersLoading}
            resultByStoryId={resultByStoryId}
            onChange={updateOverride}
          />
        </CardContent>
      </Card>

      {result ? <ResultPanel result={result} /> : null}
    </div>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-sm font-semibold text-[#172B4D]">
        {label}
        {required ? <span className="ml-1 text-red-600">*</span> : null}
      </Label>
      {children}
    </div>
  );
}

function StorySelectionTable({
  stories,
  selectedStoryIds,
  allLoadedSelected,
  loading,
  onToggleStory,
  onToggleAll,
}: {
  stories: UserStory[];
  selectedStoryIds: string[];
  allLoadedSelected: boolean;
  loading: boolean;
  onToggleStory: (storyId: string, checked: boolean) => void;
  onToggleAll: (checked: boolean) => void;
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

  if (loading) {
    return <div className="rounded-md border border-[#DCDFE4] bg-white p-5 text-sm text-[#626F86]">Loading user stories...</div>;
  }

  if (!stories.length) {
    return <div className="rounded-md border border-[#DCDFE4] bg-white p-5 text-sm text-[#626F86]">No user stories loaded.</div>;
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-10">
            <Checkbox checked={allLoadedSelected} onCheckedChange={(checked) => onToggleAll(checked === true)} aria-label="Select all stories" />
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
        {sortedStories.map((story) => {
          const selected = selectedStoryIds.includes(story.id);
          return (
            <TableRow key={story.id} className={selected ? "qa-table-row-selected" : "qa-table-row"}>
              <TableCell>
                <Checkbox checked={selected} onCheckedChange={(checked) => onToggleStory(story.id, checked === true)} aria-label={`Select story ${story.id}`} />
              </TableCell>
              <TableCell className="font-mono text-xs font-semibold text-[#0C66E4]">{story.id}</TableCell>
              <TableCell className="min-w-[320px] whitespace-normal font-medium text-[#172B4D]">{story.title}</TableCell>
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
      className="-ml-2 h-8 px-2 text-[#172B4D]"
      onClick={onClick}
      aria-label={`Sort by ${label} ${active && direction === "asc" ? "descending" : "ascending"}`}
      aria-sort={active ? (direction === "asc" ? "ascending" : "descending") : "none"}
    >
      {label}
      <Icon className="size-3.5" aria-hidden="true" />
      {active ? <span className="text-xs text-[#626F86]">{direction === "asc" ? "Asc" : "Desc"}</span> : null}
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

function TargetOverrideTable({
  rows,
  overrides,
  users,
  usersLoading,
  resultByStoryId,
  onChange,
}: {
  rows: TargetRow[];
  overrides: Record<string, OverrideValues>;
  users: ProjectUser[];
  usersLoading: boolean;
  resultByStoryId: Map<string, BulkTaskResponse["results"][number]>;
  onChange: (storyId: string, field: keyof OverrideValues, value: string) => void;
}) {
  if (!rows.length) {
    return <div className="rounded-md border border-[#DCDFE4] bg-white p-5 text-sm text-[#626F86]">No target stories selected.</div>;
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Story ID</TableHead>
          <TableHead className="min-w-[260px]">Story</TableHead>
          <TableHead>Row assignee</TableHead>
          <TableHead>Row estimate</TableHead>
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const rowOverride = overrides[row.storyId] ?? { assignedTo: "", originalEstimate: "" };
          const rowResult = resultByStoryId.get(row.storyId);
          return (
            <TableRow key={row.key} className="qa-table-row">
              <TableCell className="font-mono text-xs font-semibold text-[#0C66E4]">{row.storyId}</TableCell>
              <TableCell className="min-w-[260px] whitespace-normal">
                <div className="font-medium text-[#172B4D]">{row.title ?? "Manual target"}</div>
                <div className="mt-1 flex flex-wrap gap-1 text-xs text-[#626F86]">
                  {row.state ? <Badge variant="secondary">{row.state}</Badge> : null}
                  {row.assignedTo ? <span className="max-w-[180px] truncate">{row.assignedTo}</span> : null}
                </div>
              </TableCell>
              <TableCell>
                <AssigneeSelect
                  value={rowOverride.assignedTo}
                  users={users}
                  loading={usersLoading}
                  onChange={(value) => onChange(row.storyId, "assignedTo", value)}
                  placeholder="Template default"
                  className="min-w-[220px]"
                />
              </TableCell>
              <TableCell>
                <Input
                  value={rowOverride.originalEstimate}
                  onChange={(event) => {
                    if (isAllowedEstimateInput(event.target.value)) onChange(row.storyId, "originalEstimate", event.target.value);
                  }}
                  inputMode="decimal"
                  pattern="(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?"
                  placeholder="Template default"
                  className="w-36"
                />
              </TableCell>
              <TableCell>
                <ResultBadge result={rowResult} />
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function AssigneeSelect({
  value,
  users,
  loading,
  onChange,
  placeholder,
  className = "",
}: {
  value: string;
  users: ProjectUser[];
  loading: boolean;
  onChange: (value: string) => void;
  placeholder: string;
  className?: string;
}) {
  const userValues = new Set(users.map((user) => assigneeValue(user)));
  return (
    <select
      className={`focus-ring h-10 w-full rounded-md border border-input bg-white px-3 text-sm ${className}`}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      disabled={loading}
    >
      <option value="">{loading ? "Loading users..." : placeholder}</option>
      {value && !userValues.has(value) ? <option value={value}>{value}</option> : null}
      {users.map((user) => (
        <option key={user.id} value={assigneeValue(user)}>
          {user.displayName}{user.uniqueName ? ` (${user.uniqueName})` : ""}
        </option>
      ))}
    </select>
  );
}

function ResultBadge({ result }: { result?: BulkTaskResponse["results"][number] }) {
  if (!result) return <Badge variant="outline">Pending</Badge>;
  if (result.status === "created") return <Badge className="bg-emerald-600 text-white">Created #{result.taskId}</Badge>;
  if (result.status === "skipped") return <Badge className="bg-amber-500 text-white">Skipped</Badge>;
  return <Badge variant="destructive">Failed</Badge>;
}

function ResultPanel({ result }: { result: BulkTaskResponse }) {
  return (
    <Card className="qa-card">
      <CardHeader>
        <CardTitle className="text-base">Result</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <Metric label="Requested" value={result.requestedCount} />
          <Metric label="Created" value={result.created.length} tone="success" />
          <Metric label="Failed or skipped" value={result.failed.length} tone={result.failed.length ? "warning" : "default"} />
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-md border border-[#DCDFE4] bg-white">
            <div className="flex items-center gap-2 border-b border-[#EBECF0] px-3 py-2 text-sm font-semibold text-[#172B4D]">
              <CheckCircle2 className="size-4 text-emerald-600" />
              Created tasks
            </div>
            <div className="divide-y divide-[#EBECF0]">
              {result.created.length ? result.created.map((item) => (
                <div key={`${item.storyId}-${item.taskId}`} className="grid gap-1 px-3 py-2 text-sm sm:grid-cols-[110px_1fr]">
                  <span className="font-mono text-xs font-semibold text-[#0C66E4]">Story {item.storyId}</span>
                  <span>Task {item.taskId}: {item.title}</span>
                </div>
              )) : <div className="px-3 py-4 text-sm text-[#626F86]">No tasks created.</div>}
            </div>
          </div>

          <div className="rounded-md border border-[#DCDFE4] bg-white">
            <div className="flex items-center gap-2 border-b border-[#EBECF0] px-3 py-2 text-sm font-semibold text-[#172B4D]">
              <XCircle className="size-4 text-red-600" />
              Failed stories
            </div>
            <div className="divide-y divide-[#EBECF0]">
              {result.failed.length ? result.failed.map((item) => (
                <div key={`${item.storyId}-${item.status}-${item.error}`} className="grid gap-1 px-3 py-2 text-sm sm:grid-cols-[110px_1fr]">
                  <span className="font-mono text-xs font-semibold text-[#0C66E4]">Story {item.storyId}</span>
                  <span>{item.error}</span>
                </div>
              )) : <div className="px-3 py-4 text-sm text-[#626F86]">No failures.</div>}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function Metric({ label, value, tone = "default" }: { label: string; value: number; tone?: "default" | "success" | "warning" }) {
  const valueClass = tone === "success" ? "text-emerald-700" : tone === "warning" ? "text-amber-700" : "text-[#172B4D]";
  return (
    <div className="rounded-md border border-[#DCDFE4] bg-white p-3">
      <div className="text-xs text-[#626F86]">{label}</div>
      <div className={`mt-1 text-xl font-semibold ${valueClass}`}>{value}</div>
    </div>
  );
}

function parseManualIds(value: string) {
  const tokens = value.split(/[,\s;]+/).map((token) => token.trim()).filter(Boolean);
  const invalid = tokens.filter((token) => !/^\d+$/.test(token));
  const ids = tokens.filter((token) => /^\d+$/.test(token));
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  ids.forEach((id) => {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  });
  return { ids, invalid, duplicates: [...duplicates] };
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

function assigneeValue(user: ProjectUser) {
  return user.uniqueName ?? user.displayName;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
}
