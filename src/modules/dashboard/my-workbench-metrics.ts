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
  WorkbenchStatusGroup,
} from "@/types/my-workbench-dashboard";

export const WORKBENCH_STATUS_GROUPS: WorkbenchStatusGroup[] = [
  "To Do",
  "Active",
  "Blocked / Waiting",
  "Review / Testing",
  "Done",
  "Other / Unmapped",
];

export const DEFAULT_WORKBENCH_FILTERS: WorkbenchFilters = {
  sprintMode: "current",
  iterationPath: null,
  workItemTypes: [],
  statusGroups: ["To Do", "Active", "Blocked / Waiting", "Review / Testing", "Other / Unmapped"],
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
    : scopedItems.filter((item) => normalizeWorkbenchState(item.state) !== "Done");
  const completedExcluded = scopedItems.length - openScopedItems.length;
  const filteredItems = openScopedItems.filter((item) => passesWorkbenchFilters(item, input.filters));
  const currentSprintPath = findCurrentIteration(input.iterations, today)?.path ?? null;
  const focusList = filteredItems
    .map((item) => buildFocusItem({
      item,
      today,
      selectedSprint,
      currentSprintPath,
      parent: firstParent(item, input.parentsById),
      url: input.buildWorkItemUrl(item.id),
    }))
    .sort(compareFocusItems);

  const assignedBySprint = buildAssignedBySprint(openScopedItems, input.iterations, today);
  const cards = buildWorkbenchCards(focusList, selectedSprint, today);
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

export function normalizeWorkbenchState(state?: string | null): WorkbenchStatusGroup {
  const value = normalizeText(state);
  if (!value) return "Other / Unmapped";

  if (hasToken(value, ["blocked", "impeded", "pending clarification", "waiting", "on hold", "hold"])) {
    return "Blocked / Waiting";
  }
  if (hasToken(value, ["code review", "ready for qa", "ready for test", "ready to test", "in review", "review", "qa", "test", "testing", "uat"])) {
    return "Review / Testing";
  }
  if (beginsWithToken(value, ["done", "closed", "completed", "resolved", "removed", "cancelled", "canceled"])) {
    return "Done";
  }
  if (hasToken(value, ["active", "in progress", "development", "committed", "doing"])) {
    return "Active";
  }
  if (hasToken(value, ["new", "to do", "todo", "proposed", "ready", "ready for dev", "approved"])) {
    return "To Do";
  }
  return "Other / Unmapped";
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

export function passesWorkbenchFilters(item: Requirement, filters: WorkbenchFilters) {
  if (filters.workItemTypes.length && !filters.workItemTypes.includes(item.workItemType)) return false;
  if (filters.statusGroups.length && !filters.statusGroups.includes(normalizeWorkbenchState(item.state))) return false;
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
  const status = normalizeWorkbenchState(input.item.state);
  const sprintEndDate = sprintEndForItem(input.item, input.selectedSprint);
  const urgencyDate = datePart(input.item.dueDate) ?? sprintEndDate;
  const overdue = Boolean(urgencyDate && urgencyDate < input.today && status !== "Done");
  const dueSoon = Boolean(urgencyDate && !overdue && daysBetween(input.today, urgencyDate) <= 2);
  const blocked = isBlockedWorkItem(input.item, status);
  const highPriority = Boolean(input.item.priority && input.item.priority <= 2);
  const unestimated = hasMissingEstimate(input.item);
  const currentSprint = Boolean(input.currentSprintPath && normalizePath(input.item.iterationPath) === normalizePath(input.currentSprintPath));
  const unmapped = status === "Other / Unmapped";
  const activeAging = status === "Active" && businessDaysBetween(datePart(input.item.updatedDate), input.today) >= 5;
  const atRisk = isAtRisk({ item: input.item, status, overdue, dueSoon, blocked, highPriority, unestimated, activeAging, today: input.today, sprintEndDate });
  const focusBadges = focusBadgesFor({ blocked, overdue, dueSoon, highPriority, unestimated, currentSprint, atRisk, unmapped });

  return {
    id: input.item.id,
    title: input.item.title,
    url: input.url,
    focusScore: focusScore({ status, blocked, overdue, dueSoon, highPriority, unestimated, currentSprint, unmapped, activeAging, atRisk, item: input.item }),
    focusBadges,
    type: input.item.workItemType || "Unknown",
    state: input.item.state ?? "Unknown",
    status,
    parent: input.parent,
    sprint: input.item.iterationPath ?? null,
    remainingWork: numberOrNull(input.item.remainingWork),
    completedWork: numberOrNull(input.item.completedWork),
    originalEstimate: numberOrNull(input.item.originalEstimate),
    priority: numberOrNull(input.item.priority),
    dueDate: datePart(input.item.dueDate),
    sprintEndDate,
    tags: input.item.tags ?? [],
    blockerSummary: blockerSummary(input.item, status),
    changedDate: datePart(input.item.updatedDate),
  };
}

export function isBlockedWorkItem(item: Requirement, status = normalizeWorkbenchState(item.state)) {
  if (status === "Blocked / Waiting") return true;
  const state = normalizeText(item.state);
  const tags = (item.tags ?? []).map(normalizeText);
  return hasToken(state, ["blocked", "impeded", "pending clarification", "waiting", "on hold"])
    || tags.some((tag) => hasToken(tag, ["blocked", "impeded", "waiting", "on hold"]));
}

export function hasMissingEstimate(item: Requirement) {
  return item.remainingWork === undefined || item.remainingWork === null || !Number.isFinite(item.remainingWork);
}

function isAtRisk(input: {
  item: Requirement;
  status: WorkbenchStatusGroup;
  overdue: boolean;
  dueSoon: boolean;
  blocked: boolean;
  highPriority: boolean;
  unestimated: boolean;
  activeAging: boolean;
  today: string;
  sprintEndDate: string | null;
}) {
  if (input.blocked || input.overdue || input.activeAging) return true;
  if (input.dueSoon && (input.item.remainingWork ?? 0) >= 4) return true;
  if (input.highPriority && input.status === "To Do") return true;
  if (input.unestimated && input.sprintEndDate && input.sprintEndDate >= input.today) return true;
  if (input.sprintEndDate && daysBetween(input.today, input.sprintEndDate) <= 2 && (input.item.remainingWork ?? 0) > 0) return true;
  return input.status === "Other / Unmapped";
}

function focusScore(input: {
  item: Requirement;
  status: WorkbenchStatusGroup;
  blocked: boolean;
  overdue: boolean;
  dueSoon: boolean;
  highPriority: boolean;
  unestimated: boolean;
  currentSprint: boolean;
  unmapped: boolean;
  activeAging: boolean;
  atRisk: boolean;
}) {
  let score = 0;
  if (input.blocked) score += 130;
  if (input.overdue) score += 90;
  if (input.dueSoon) score += 70;
  if (input.highPriority) score += 60;
  if (input.currentSprint) score += 50;
  if (input.status === "Active" || input.status === "Review / Testing") score += 30;
  if ((input.item.remainingWork ?? 0) >= 8) score += 20;
  if (input.unestimated) score += 25;
  if (input.unmapped) score += 25;
  if (input.activeAging) score += 40;
  if (input.atRisk) score += 20;
  if (isBacklogItem(input.item)) score -= 10;
  return score;
}

function focusBadgesFor(input: {
  blocked: boolean;
  overdue: boolean;
  dueSoon: boolean;
  highPriority: boolean;
  unestimated: boolean;
  currentSprint: boolean;
  atRisk: boolean;
  unmapped: boolean;
}) {
  const badges: WorkbenchFocusBadge[] = [];
  if (input.blocked) badges.push("Blocked");
  if (input.overdue) badges.push("Overdue");
  if (input.dueSoon) badges.push("Due Soon");
  if (input.highPriority) badges.push("High Priority");
  if (input.unestimated) badges.push("No Estimate");
  if (input.currentSprint) badges.push("Current Sprint");
  if (input.atRisk) badges.push("At Risk");
  if (input.unmapped) badges.push("Unmapped State");
  return badges;
}

function compareFocusItems(first: WorkbenchFocusItem, second: WorkbenchFocusItem) {
  return second.focusScore - first.focusScore
    || priorityRank(first.priority) - priorityRank(second.priority)
    || dateRank(first.dueDate ?? first.sprintEndDate) - dateRank(second.dueDate ?? second.sprintEndDate)
    || (second.remainingWork ?? -1) - (first.remainingWork ?? -1)
    || first.id.localeCompare(second.id);
}

function buildWorkbenchCards(items: WorkbenchFocusItem[], selectedSprint: WorkbenchIterationSelection, today: string): WorkbenchCard[] {
  const openItems = items.filter((item) => item.status !== "Done");
  const blocked = openItems.filter((item) => item.focusBadges.includes("Blocked"));
  const atRisk = openItems.filter((item) => item.focusBadges.includes("At Risk"));
  const unestimated = openItems.filter((item) => item.focusBadges.includes("No Estimate"));
  const highPriority = openItems.filter((item) => item.focusBadges.includes("High Priority"));
  const dueSoon = openItems.filter((item) => item.focusBadges.includes("Due Soon"));
  const focusNow = openItems.filter((item) => item.focusBadges.some((badge) => ["Blocked", "Overdue", "Due Soon", "High Priority", "At Risk"].includes(badge)));
  const remaining = sumNumbers(openItems.map((item) => item.remainingWork));
  const activeRemaining = sumNumbers(openItems.filter((item) => item.status === "Active" || item.status === "Review / Testing").map((item) => item.remainingWork));
  const todoRemaining = sumNumbers(openItems.filter((item) => item.status === "To Do").map((item) => item.remainingWork));
  const completed = sumNumbers(openItems.map((item) => item.completedWork));
  const progress = calculateProgress(completed, remaining);
  const daysLeft = selectedSprint.finishDate ? Math.max(0, daysBetween(today, selectedSprint.finishDate)) : null;
  const sprintStatus = sprintProgressStatus(progress, selectedSprint, today, unestimated.length);

  return [
    {
      key: "focusNow",
      title: "Focus Now",
      value: `${focusNow.length} ${focusNow.length === 1 ? "item" : "items"}`,
      subtitle: `${highPriority.length} high priority - ${dueSoon.length} due soon - ${blocked.length} blocked`,
      tone: focusNow.length ? "yellow" : "green",
    },
    {
      key: "remainingWork",
      title: "Remaining Work",
      value: unestimated.length ? "Incomplete estimate" : `${formatHours(remaining)} remaining`,
      subtitle: unestimated.length ? `${unestimated.length} ${unestimated.length === 1 ? "item has" : "items have"} no remaining hours` : `${formatHours(activeRemaining)} active - ${formatHours(todoRemaining)} not started`,
      tone: unestimated.length ? "yellow" : "blue",
    },
    {
      key: "sprintProgress",
      title: "Sprint Progress",
      value: progress === null ? "No estimate" : `${progress}% complete`,
      subtitle: `${formatHours(remaining)} remaining${daysLeft === null ? "" : ` - ${daysLeft} ${daysLeft === 1 ? "day" : "days"} left`} - ${sprintStatus}`,
      tone: sprintStatus === "On Track" ? "green" : sprintStatus === "Behind" ? "red" : sprintStatus === "No Estimate" ? "neutral" : "yellow",
    },
    {
      key: "blockedWaiting",
      title: "Blocked / Waiting",
      value: `${blocked.length} ${blocked.length === 1 ? "item" : "items"}`,
      subtitle: blockerCardSubtitle(blocked),
      tone: blocked.length ? "red" : "green",
    },
    {
      key: "atRisk",
      title: "At Risk",
      value: `${atRisk.length} ${atRisk.length === 1 ? "item" : "items"}`,
      subtitle: `${openItems.filter((item) => item.focusBadges.includes("Overdue")).length} overdue - ${openItems.filter((item) => item.focusBadges.includes("No Estimate")).length} unestimated`,
      tone: atRisk.length ? "yellow" : "green",
    },
    {
      key: "unestimatedWork",
      title: "Unestimated Work",
      value: `${unestimated.length} ${unestimated.length === 1 ? "item" : "items"}`,
      subtitle: unestimated.length ? "Missing Remaining Work" : "Remaining Work is available",
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
      const blocked = group.filter((item) => isBlockedWorkItem(item)).length;
      return {
        sprint,
        items: group.length,
        remainingWork,
        completedWork,
        blocked,
        unestimated,
        status: sprintStatusForGroup({ sprint, iteration, remainingWork, completedWork, blocked, unestimated, today }),
      };
    })
    .sort((first, second) => sprintRowRank(first.sprint, iterationByPath, today) - sprintRowRank(second.sprint, iterationByPath, today) || first.sprint.localeCompare(second.sprint))
    .slice(0, WORKBENCH_LIMITS.tableRows);
}

function remainingWorkByStatus(items: WorkbenchFocusItem[]) {
  return WORKBENCH_STATUS_GROUPS.map((status) => ({
    name: status,
    key: status,
    value: round(sumNumbers(items.filter((item) => item.status === status).map((item) => item.remainingWork))),
  })).filter((item) => item.value > 0 || item.name === "Other / Unmapped");
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

function blockerSummary(item: Requirement, status: WorkbenchStatusGroup) {
  if (status === "Blocked / Waiting") return item.state ? `State: ${item.state}` : "Blocked or waiting";
  const blockedTag = (item.tags ?? []).find((tag) => normalizeText(tag).includes("blocked"));
  if (blockedTag) return `Tag: ${blockedTag}`;
  return null;
}

function blockerCardSubtitle(items: WorkbenchFocusItem[]) {
  const dependencies = items.filter((item) => item.blockerSummary?.toLowerCase().includes("dependency")).length;
  const clarification = items.filter((item) => item.blockerSummary?.toLowerCase().includes("clarification")).length;
  if (dependencies || clarification) return `${dependencies} dependency - ${clarification} needs clarification`;
  return items.length ? "Review blocked states and tags" : "No blocked assigned work";
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
  blocked: number;
  unestimated: number;
  today: string;
}): WorkbenchRiskStatus {
  if (input.sprint === "Backlog / No Sprint") return "No Sprint";
  if (input.unestimated > 0) return "Needs Estimate";
  if (input.blocked > 0) return "At Risk";
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

function businessDaysBetween(from: string | null, to: string) {
  if (!from || from > to) return 0;
  let count = 0;
  const cursor = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T00:00:00`);
  while (cursor < end) {
    const day = cursor.getDay();
    if (day !== 0 && day !== 6) count += 1;
    cursor.setDate(cursor.getDate() + 1);
  }
  return count;
}

function datePart(value?: string | null) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : toLocalDayString(date);
}

function normalizeText(value?: string | null) {
  return (value ?? "").trim().replace(/[_-]+/g, " ").replace(/\s+/g, " ").toLowerCase();
}

function normalizePath(value?: string | null) {
  return (value ?? "").trim().toLocaleLowerCase();
}

function hasToken(value: string, tokens: string[]) {
  return tokens.some((token) => value.includes(token));
}

function beginsWithToken(value: string, tokens: string[]) {
  return tokens.some((token) => value === token || value.startsWith(`${token} `) || value.startsWith(`${token} -`) || value.startsWith(`${token} (`));
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
  scopedItems: Requirement[];
  today?: Date;
}): MyWorkbenchAnalytics["filterMetadata"] {
  const today = toLocalDayString(input.today ?? new Date());
  const current = findCurrentIteration(input.iterations, today)?.path;
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
    statusGroups: WORKBENCH_STATUS_GROUPS.map((status) => ({ value: status, label: status })),
  };
}
