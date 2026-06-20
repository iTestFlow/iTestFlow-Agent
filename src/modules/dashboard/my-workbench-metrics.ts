import type { AzureIteration, Requirement } from "@/modules/integrations/azure-devops/azure-devops-types";
import { toLocalDayString } from "@/shared/lib/local-day";
import type {
  MyWorkbenchAnalytics,
  WorkbenchBurnPoint,
  WorkbenchCard,
  WorkbenchFilters,
  WorkbenchFocusBadge,
  WorkbenchFocusItem,
  WorkbenchRiskStatus,
  WorkbenchSprintMode,
  WorkbenchSprintRow,
} from "@/types/my-workbench-dashboard";

export const NO_PARENT_FILTER_VALUE = "__no_parent__";

export const DEFAULT_WORKBENCH_FILTERS: WorkbenchFilters = {
  sprintMode: "current",
  iterationPath: null,
  workItemTypes: [],
  states: [],
  parentIds: [],
  priority: "all",
  areaPath: null,
  includeCompleted: false,
  includeBacklog: false,
};

export const WORKBENCH_LIMITS = {
  assignedWorkItems: 2000,
  tableRows: 100,
  chartSlices: 12,
} as const;

type WorkbenchParent = {
  id: string;
  title: string;
  url: string | null;
};

export type WorkbenchBuildInput = {
  items: Requirement[];
  parentsById: Map<string, WorkbenchParent>;
  filters: WorkbenchFilters;
  iterations: AzureIteration[];
  buildWorkItemUrl: (id: string) => string | null;
  today?: Date;
};

export type WorkbenchIterationSelection = {
  mode: WorkbenchSprintMode;
  path: string | null;
  startDate: string | null;
  finishDate: string | null;
  paths: Set<string>;
};

export function buildMyWorkbenchAnalyticsModel(input: WorkbenchBuildInput) {
  const today = toLocalDayString(input.today ?? new Date());
  const selectedSprint = resolveWorkbenchIteration(input.filters, input.iterations, today);
  const scopedItems = input.items.filter((item) => isInWorkbenchSprintScope(item, selectedSprint, input.filters));
  const openScopedItems = input.filters.includeCompleted
    ? scopedItems
    : scopedItems.filter((item) => !isClosedState(item.state));
  const completedExcluded = scopedItems.length - openScopedItems.length;
  const filteredItems = openScopedItems
    .map((item) => ({ item, parent: firstParent(item, input.parentsById) }))
    .filter(({ item, parent }) => passesWorkbenchFilters(item, parent, input.filters));
  const currentSprintPath = findCurrentIteration(input.iterations, today)?.path ?? null;
  const focusList = filteredItems
    .map(({ item, parent }) => buildFocusItem({
      item,
      today,
      selectedSprint,
      currentSprintPath,
      parent,
      url: input.buildWorkItemUrl(item.id),
    }))
    .sort(compareFocusItems);

  const assignedBySprint = buildAssignedBySprint(filteredItems.map(({ item }) => item), input.iterations, today);
  const cards = buildWorkbenchCards(focusList);
  const tableRows = focusList.slice(0, WORKBENCH_LIMITS.tableRows);

  return {
    filters: input.filters,
    selectedSprint,
    cards,
    focusList: tableRows,
    assignedBySprint,
    charts: {
      remainingWorkByStatus: remainingWorkByStatus(focusList),
      sprintBurnStatus: buildSprintBurnStatus(focusList, selectedSprint, today),
      workItemsByType: workItemsByType(focusList),
    },
    counts: {
      assigned: input.items.length,
      scoped: scopedItems.length,
      filtered: filteredItems.length,
      completedExcluded,
      tableRows: tableRows.length,
    },
    warnings: buildWarnings(input.items, focusList),
  };
}

export function isClosedState(state?: string | null) {
  return normalizeStateValue(state) === "closed";
}

export function resolveWorkbenchIteration(
  filters: WorkbenchFilters,
  iterations: AzureIteration[],
  today = toLocalDayString(new Date()),
): WorkbenchIterationSelection {
  const ordered = iterations
    .filter((iteration) => iteration.path)
    .sort((first, second) => (datePart(first.startDate) ?? "").localeCompare(datePart(second.startDate) ?? "") || first.path.localeCompare(second.path));
  const active = ordered.filter((iteration) => isDateWithin(today, datePart(iteration.startDate), datePart(iteration.finishDate)));
  const current = findDefaultIteration(ordered, today);
  const currentIndex = current ? ordered.findIndex((iteration) => iteration.path === current.path) : -1;
  const previous = currentIndex > 0 ? ordered[currentIndex - 1] : ordered.filter((iteration) => datePart(iteration.finishDate) && (datePart(iteration.finishDate) as string) < today).at(-1);
  const next = currentIndex >= 0 && currentIndex < ordered.length - 1
    ? ordered[currentIndex + 1]
    : ordered.find((iteration) => datePart(iteration.startDate) && (datePart(iteration.startDate) as string) > today);

  if (filters.sprintMode === "overall") {
    return { mode: filters.sprintMode, path: null, startDate: null, finishDate: null, paths: new Set() };
  }
  if (filters.sprintMode === "all_active") {
    return {
      mode: filters.sprintMode,
      path: null,
      startDate: minDate(active.map((iteration) => datePart(iteration.startDate))),
      finishDate: maxDate(active.map((iteration) => datePart(iteration.finishDate))),
      paths: new Set(active.map((iteration) => normalizePath(iteration.path))),
    };
  }
  const selected = filters.sprintMode === "custom"
    ? ordered.find((iteration) => normalizePath(iteration.path) === normalizePath(filters.iterationPath)) ?? current
    : filters.sprintMode === "previous"
      ? previous
      : filters.sprintMode === "next"
        ? next
        : current;

  return {
    mode: filters.sprintMode,
    path: selected?.path ?? null,
    startDate: datePart(selected?.startDate),
    finishDate: datePart(selected?.finishDate),
    paths: selected?.path ? new Set([normalizePath(selected.path)]) : new Set(),
  };
}

export function isInWorkbenchSprintScope(item: Requirement, selectedSprint: WorkbenchIterationSelection, filters: WorkbenchFilters) {
  if (selectedSprint.mode === "overall") return true;
  const itemIteration = normalizePath(item.iterationPath);
  const inSelectedSprint = itemIteration && [...selectedSprint.paths].some((path) => itemIteration === path || itemIteration.startsWith(`${path}\\`));
  if (inSelectedSprint) return true;
  return filters.includeBacklog && isBacklogItem(item);
}

export function passesWorkbenchFilters(item: Requirement, parent: WorkbenchParent | null, filters: WorkbenchFilters) {
  if (filters.workItemTypes.length && !filters.workItemTypes.includes(item.workItemType)) return false;
  if (filters.states.length && !filters.states.includes(stateLabel(item.state))) return false;
  if (filters.parentIds.length) {
    const parentValue = parent?.id ?? NO_PARENT_FILTER_VALUE;
    if (!filters.parentIds.includes(parentValue)) return false;
  }
  if (filters.priority !== "all") {
    if (filters.priority === "none" && item.priority !== undefined && item.priority !== null) return false;
    if (filters.priority !== "none" && item.priority !== Number(filters.priority)) return false;
  }
  return true;
}

export function buildFocusItem(input: {
  item: Requirement;
  today: string;
  selectedSprint: WorkbenchIterationSelection;
  currentSprintPath: string | null;
  parent: WorkbenchParent | null;
  url: string | null;
}): WorkbenchFocusItem {
  const closed = isClosedState(input.item.state);
  const sprintEndDate = sprintEndForItem(input.item, input.selectedSprint);
  const urgencyDate = datePart(input.item.dueDate) ?? sprintEndDate;
  const overdue = Boolean(!closed && urgencyDate && urgencyDate < input.today);
  const dueSoon = Boolean(!closed && urgencyDate && !overdue && daysBetween(input.today, urgencyDate) <= 2);
  const highPriority = Boolean(input.item.priority && input.item.priority <= 2);
  const unestimated = hasMissingEstimate(input.item);
  const currentSprint = Boolean(input.currentSprintPath && normalizePath(input.item.iterationPath) === normalizePath(input.currentSprintPath));
  const atRisk = isAtRisk({ item: input.item, closed, overdue, dueSoon, highPriority, unestimated, today: input.today, sprintEndDate });
  const focusBadges = focusBadgesFor({ overdue, dueSoon, highPriority, unestimated, currentSprint, atRisk });

  return {
    id: input.item.id,
    title: input.item.title,
    url: input.url,
    focusScore: focusScore({ closed, overdue, dueSoon, highPriority, unestimated, currentSprint, atRisk, item: input.item }),
    focusBadges,
    type: input.item.workItemType || "Unknown",
    state: stateLabel(input.item.state),
    parent: input.parent,
    sprint: input.item.iterationPath ?? null,
    remainingWork: numberOrNull(input.item.remainingWork),
    completedWork: numberOrNull(input.item.completedWork),
    originalEstimate: numberOrNull(input.item.originalEstimate),
    priority: numberOrNull(input.item.priority),
    dueDate: datePart(input.item.dueDate),
    sprintEndDate,
    tags: input.item.tags ?? [],
    changedDate: datePart(input.item.updatedDate),
  };
}

export function hasMissingEstimate(item: Requirement) {
  return item.remainingWork === undefined || item.remainingWork === null || !Number.isFinite(item.remainingWork);
}

function isAtRisk(input: {
  item: Requirement;
  closed: boolean;
  overdue: boolean;
  dueSoon: boolean;
  highPriority: boolean;
  unestimated: boolean;
  today: string;
  sprintEndDate: string | null;
}) {
  if (input.closed) return false;
  if (input.overdue) return true;
  if (input.dueSoon && (input.item.remainingWork ?? 0) >= 4) return true;
  if (input.highPriority) return true;
  if (input.unestimated && input.sprintEndDate && input.sprintEndDate >= input.today) return true;
  if (input.sprintEndDate && daysBetween(input.today, input.sprintEndDate) <= 2 && (input.item.remainingWork ?? 0) > 0) return true;
  return false;
}

function focusScore(input: {
  item: Requirement;
  closed: boolean;
  overdue: boolean;
  dueSoon: boolean;
  highPriority: boolean;
  unestimated: boolean;
  currentSprint: boolean;
  atRisk: boolean;
}) {
  if (input.closed) return 0;
  let score = 0;
  if (input.overdue) score += 90;
  if (input.dueSoon) score += 70;
  if (input.highPriority) score += 60;
  if (input.currentSprint) score += 50;
  if ((input.item.remainingWork ?? 0) >= 8) score += 20;
  if (input.unestimated) score += 25;
  if (input.atRisk) score += 20;
  if (isBacklogItem(input.item)) score -= 10;
  return score;
}

function focusBadgesFor(input: {
  overdue: boolean;
  dueSoon: boolean;
  highPriority: boolean;
  unestimated: boolean;
  currentSprint: boolean;
  atRisk: boolean;
}) {
  const badges: WorkbenchFocusBadge[] = [];
  if (input.overdue) badges.push("Overdue");
  if (input.dueSoon) badges.push("Due Soon");
  if (input.highPriority) badges.push("High Priority");
  if (input.unestimated) badges.push("No Estimate");
  if (input.currentSprint) badges.push("Current Sprint");
  if (input.atRisk) badges.push("At Risk");
  return badges;
}

function compareFocusItems(first: WorkbenchFocusItem, second: WorkbenchFocusItem) {
  return second.focusScore - first.focusScore
    || priorityRank(first.priority) - priorityRank(second.priority)
    || dateRank(first.dueDate ?? first.sprintEndDate) - dateRank(second.dueDate ?? second.sprintEndDate)
    || (second.remainingWork ?? -1) - (first.remainingWork ?? -1)
    || first.id.localeCompare(second.id);
}

function buildWorkbenchCards(items: WorkbenchFocusItem[]): WorkbenchCard[] {
  const openItems = items.filter((item) => !isClosedState(item.state));
  const unestimated = openItems.filter((item) => item.focusBadges.includes("No Estimate"));
  const remaining = sumNumbers(openItems.map((item) => item.remainingWork));
  const completed = sumNumbers(openItems.map((item) => item.completedWork));
  const missingEstimatePercent = openItems.length ? Math.round((unestimated.length / openItems.length) * 100) : 0;

  return [
    {
      key: "openWork",
      title: "Open Work",
      value: `${openItems.length} ${openItems.length === 1 ? "item" : "items"}`,
      subtitle: "Selected sprint scope",
      tone: openItems.length ? "blue" : "green",
    },
    {
      key: "remainingWork",
      title: "Remaining Work",
      value: `${formatHours(remaining)} remaining`,
      subtitle: unestimated.length ? `${unestimated.length} ${unestimated.length === 1 ? "item" : "items"} missing estimates` : `${openItems.length} open ${openItems.length === 1 ? "item" : "items"} - ${formatHours(completed)} completed`,
      tone: unestimated.length ? "yellow" : "blue",
    },
    {
      key: "missingEstimates",
      title: "Missing Estimates",
      value: `${unestimated.length} ${unestimated.length === 1 ? "item" : "items"}`,
      subtitle: unestimated.length ? `${missingEstimatePercent}% of open work` : "Remaining Work is available",
      tone: unestimated.length ? "yellow" : "green",
    },
  ];
}

function buildAssignedBySprint(items: Requirement[], iterations: AzureIteration[], today: string): WorkbenchSprintRow[] {
  const iterationByPath = new Map(iterations.map((iteration) => [normalizePath(iteration.path), iteration]));
  const groups = new Map<string, Requirement[]>();
  items.forEach((item) => {
    const key = isBacklogItem(item) ? "Backlog / No Sprint" : item.iterationPath ?? "Backlog / No Sprint";
    groups.set(key, [...(groups.get(key) ?? []), item]);
  });
  return [...groups.entries()]
    .map(([sprint, group]) => {
      const iteration = iterationByPath.get(normalizePath(sprint));
      const remainingWork = nullableSum(group.map((item) => item.remainingWork));
      const completedWork = nullableSum(group.map((item) => item.completedWork));
      const unestimated = group.filter(hasMissingEstimate).length;
      return {
        sprint,
        items: group.length,
        remainingWork,
        completedWork,
        unestimated,
        status: sprintStatusForGroup({ sprint, iteration, remainingWork, completedWork, unestimated, today }),
      };
    })
    .sort((first, second) => sprintRowRank(first.sprint, iterationByPath, today) - sprintRowRank(second.sprint, iterationByPath, today) || first.sprint.localeCompare(second.sprint))
    .slice(0, WORKBENCH_LIMITS.tableRows);
}

function remainingWorkByStatus(items: WorkbenchFocusItem[]) {
  const groups = new Map<string, number>();
  items.forEach((item) => {
    groups.set(item.state, (groups.get(item.state) ?? 0) + sumNumbers([item.remainingWork]));
  });
  return [...groups.entries()]
    .map(([name, value]) => ({ name, key: name, value: round(value) }))
    .filter((item) => item.value > 0)
    .sort((first, second) => second.value - first.value || first.name.localeCompare(second.name))
    .slice(0, WORKBENCH_LIMITS.chartSlices);
}

function workItemsByType(items: WorkbenchFocusItem[]) {
  const counts = new Map<string, number>();
  items.forEach((item) => counts.set(item.type, (counts.get(item.type) ?? 0) + 1));
  return [...counts.entries()]
    .map(([name, value]) => ({ name, value, key: name }))
    .sort((first, second) => second.value - first.value || first.name.localeCompare(second.name))
    .slice(0, WORKBENCH_LIMITS.chartSlices);
}

function buildSprintBurnStatus(items: WorkbenchFocusItem[], selectedSprint: WorkbenchIterationSelection, today: string): WorkbenchBurnPoint[] {
  if (!selectedSprint.startDate || !selectedSprint.finishDate) return [];
  const remaining = sumNumbers(items.map((item) => item.remainingWork));
  const completed = sumNumbers(items.map((item) => item.completedWork));
  const total = remaining + completed;
  if (total <= 0) return [];
  const days = dateRange(selectedSprint.startDate, selectedSprint.finishDate);
  const denominator = Math.max(days.length - 1, 1);
  return days.map((date, index) => ({
    date,
    idealRemaining: round(total * Math.max(0, denominator - index) / denominator),
    ...(date === today ? { actualRemaining: round(remaining) } : {}),
  }));
}

function buildWarnings(
  allAssigned: Requirement[],
  focusItems: WorkbenchFocusItem[],
) {
  const warnings: string[] = [];
  if (allAssigned.length >= WORKBENCH_LIMITS.assignedWorkItems) {
    warnings.push(`Assigned work is limited to the latest ${WORKBENCH_LIMITS.assignedWorkItems} items returned by Azure DevOps.`);
  }
  if (focusItems.some((item) => item.focusBadges.includes("No Estimate"))) {
    warnings.push("Some work items do not have Remaining Work values. Sprint progress may be incomplete.");
  }
  return unique(warnings);
}

function firstParent(item: Requirement, parentsById: Map<string, WorkbenchParent>) {
  const id = item.parentLinks?.find((parentId) => parentsById.has(parentId));
  return id ? parentsById.get(id) ?? null : null;
}

function sprintEndForItem(item: Requirement, selectedSprint: WorkbenchIterationSelection) {
  const itemIteration = normalizePath(item.iterationPath);
  if (itemIteration && [...selectedSprint.paths].some((path) => itemIteration === path || itemIteration.startsWith(`${path}\\`))) {
    return selectedSprint.finishDate;
  }
  return null;
}

function sprintProgressStatus(progress: number | null, selectedSprint: WorkbenchIterationSelection, today: string, missingEstimateCount: number): WorkbenchRiskStatus {
  if (progress === null || missingEstimateCount > 0) return "No Estimate";
  if (!selectedSprint.startDate || !selectedSprint.finishDate) return "Planned";
  const totalDays = Math.max(1, daysBetween(selectedSprint.startDate, selectedSprint.finishDate));
  const elapsedDays = Math.min(totalDays, Math.max(0, daysBetween(selectedSprint.startDate, today)));
  const expected = Math.round((elapsedDays / totalDays) * 100);
  if (progress + 15 < expected) return "Behind";
  if (progress + 5 < expected) return "At Risk";
  return "On Track";
}

function sprintStatusForGroup(input: {
  sprint: string;
  iteration?: AzureIteration;
  remainingWork: number | null;
  completedWork: number | null;
  unestimated: number;
  today: string;
}): WorkbenchRiskStatus {
  if (input.sprint === "Backlog / No Sprint") return "No Sprint";
  if (input.unestimated > 0) return "Needs Estimate";
  const start = datePart(input.iteration?.startDate);
  const finish = datePart(input.iteration?.finishDate);
  if (!start || !finish || start > input.today) return "Planned";
  return sprintProgressStatus(calculateProgress(input.completedWork ?? 0, input.remainingWork ?? 0), { mode: "custom", path: input.sprint, startDate: start, finishDate: finish, paths: new Set([normalizePath(input.sprint)]) }, input.today, input.unestimated);
}

function sprintRowRank(sprint: string, iterationByPath: Map<string, AzureIteration>, today: string) {
  if (sprint === "Backlog / No Sprint") return 9000;
  const iteration = iterationByPath.get(normalizePath(sprint));
  const start = datePart(iteration?.startDate);
  const finish = datePart(iteration?.finishDate);
  if (isDateWithin(today, start, finish)) return 0;
  if (start && start > today) return 1000 + Number(start.replace(/-/g, ""));
  if (finish && finish < today) return 5000 - Number(finish.replace(/-/g, ""));
  return 8000;
}

function calculateProgress(completed: number, remaining: number) {
  const total = completed + remaining;
  return total > 0 ? Math.round((completed / total) * 100) : null;
}

function findCurrentIteration(iterations: AzureIteration[], today: string) {
  return iterations.find((iteration) => isDateWithin(today, datePart(iteration.startDate), datePart(iteration.finishDate)));
}

function findDefaultIteration(iterations: AzureIteration[], today: string) {
  const currentIterations = iterations.filter((iteration) => isDateWithin(today, datePart(iteration.startDate), datePart(iteration.finishDate)));
  if (currentIterations.length) {
    return [...currentIterations].sort((first, second) => second.path.length - first.path.length || first.path.localeCompare(second.path))[0];
  }
  const startedIterations = iterations
    .filter((iteration) => {
      const start = datePart(iteration.startDate);
      return Boolean(start && start <= today);
    })
    .sort((first, second) => (datePart(second.startDate) ?? "").localeCompare(datePart(first.startDate) ?? "") || second.path.length - first.path.length);
  return startedIterations[0] ?? iterations[0];
}

function isBacklogItem(item: Requirement) {
  return !item.iterationPath?.trim();
}

function dateRange(from: string, to: string) {
  const result: string[] = [];
  const cursor = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T00:00:00`);
  while (cursor <= end) {
    result.push(toLocalDayString(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return result;
}

function isDateWithin(date: string, from?: string | null, to?: string | null) {
  return Boolean(from && to && from <= date && to >= date);
}

function daysBetween(from: string, to: string) {
  return Math.floor((new Date(`${to}T00:00:00`).getTime() - new Date(`${from}T00:00:00`).getTime()) / 86_400_000);
}

function datePart(value?: string | null) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : toLocalDayString(date);
}

function stateLabel(value?: string | null) {
  return value?.trim() || "Unknown";
}

function normalizeStateValue(value?: string | null) {
  return (value ?? "").trim().toLowerCase();
}

function normalizePath(value?: string | null) {
  return (value ?? "").trim().toLocaleLowerCase();
}

function priorityRank(value: number | null) {
  return value ?? 99;
}

function dateRank(value: string | null) {
  return value ? Number(value.replace(/-/g, "")) : 99_999_999;
}

function numberOrNull(value?: number | null) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sumNumbers(values: Array<number | null | undefined>) {
  return values.reduce<number>((sum, value) => sum + (typeof value === "number" && Number.isFinite(value) ? value : 0), 0);
}

function nullableSum(values: Array<number | null | undefined>) {
  return values.some((value) => typeof value === "number" && Number.isFinite(value)) ? round(sumNumbers(values)) : null;
}

function round(value: number) {
  return Math.round(value * 10) / 10;
}

function formatHours(value: number) {
  return `${round(value)}h`;
}

function minDate(values: Array<string | null>) {
  const dates = values.filter((value): value is string => Boolean(value));
  return dates.length ? dates.sort()[0] : null;
}

function maxDate(values: Array<string | null>) {
  const dates = values.filter((value): value is string => Boolean(value));
  return dates.length ? dates.sort().at(-1) ?? null : null;
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

export function buildWorkbenchMetadata(input: {
  iterations: AzureIteration[];
  areas: Array<{ path: string }>;
  states: string[];
  scopedItems: Requirement[];
  parentsById: Map<string, WorkbenchParent>;
  today?: Date;
}): MyWorkbenchAnalytics["filterMetadata"] {
  const today = toLocalDayString(input.today ?? new Date());
  const current = findCurrentIteration(input.iterations, today)?.path;
  const parentIds = unique(input.scopedItems.flatMap((item) => {
    const parent = firstParent(item, input.parentsById);
    return parent ? [parent.id] : [];
  }));
  const hasNoParentItems = input.scopedItems.some((item) => !firstParent(item, input.parentsById));
  return {
    iterations: input.iterations.map((iteration) => {
      const startDate = datePart(iteration.startDate) ?? undefined;
      const finishDate = datePart(iteration.finishDate) ?? undefined;
      return {
        value: iteration.path,
        label: iteration.path,
        startDate,
        finishDate,
        category: iteration.path === current
          ? "current"
          : isDateWithin(today, startDate, finishDate)
            ? "active"
            : finishDate && finishDate < today
              ? "past"
              : startDate && startDate > today
                ? "future"
                : undefined,
      };
    }),
    areas: input.areas.map((area) => ({ value: area.path, label: area.path })),
    workItemTypes: unique(input.scopedItems.map((item) => item.workItemType)).map((type) => ({ value: type, label: type })),
    states: unique([...input.states, ...input.scopedItems.map((item) => stateLabel(item.state))])
      .sort((first, second) => first.localeCompare(second))
      .map((state) => ({ value: state, label: state })),
    parents: [
      ...(hasNoParentItems ? [{ value: NO_PARENT_FILTER_VALUE, label: "No parent" }] : []),
      ...parentIds
        .map((id) => input.parentsById.get(id))
        .filter((parent): parent is WorkbenchParent => Boolean(parent))
        .sort((first, second) => first.title.localeCompare(second.title) || first.id.localeCompare(second.id))
        .map((parent) => ({ value: parent.id, label: `#${parent.id} ${parent.title}`, description: parent.title })),
    ],
  };
}
