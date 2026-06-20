import "server-only";

import { getProjectScopedAzureDevOpsAdapter } from "@/modules/integrations/azure-devops/configured-azure-devops";
import type { AzureArea, AzureIteration, Requirement } from "@/modules/integrations/azure-devops/azure-devops-types";
import { assertProjectScope, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import type { MyWorkbenchAnalytics, WorkbenchFilters } from "@/types/my-workbench-dashboard";
import {
  DEFAULT_WORKBENCH_FILTERS,
  WORKBENCH_LIMITS,
  buildMyWorkbenchAnalyticsModel,
  buildWorkbenchMetadata,
  isClosedState,
  isInWorkbenchSprintScope,
  resolveWorkbenchIteration,
} from "./my-workbench-metrics";

export type MyWorkbenchAnalyticsInput = {
  scope: ProjectScope;
  filters?: Partial<WorkbenchFilters>;
};

type MetadataCacheValue = {
  iterations: AzureIteration[];
  areas: AzureArea[];
  workItemTypes: string[];
  states: string[];
};

const METADATA_CACHE_TTL_MS = 300_000;
const METADATA_CACHE_MAX_ENTRIES = 100;
const metadataCache = new Map<string, { expiresAt: number; value: MetadataCacheValue }>();

export async function getMyWorkbenchAnalytics(input: MyWorkbenchAnalyticsInput): Promise<MyWorkbenchAnalytics> {
  const scope = assertProjectScope(input.scope);
  const filters = normalizeWorkbenchFilters(input.filters);
  const adapter = getProjectScopedAzureDevOpsAdapter(scope);
  const [user, metadata] = await Promise.all([
    adapter.fetchAuthenticatedUser(),
    getCachedWorkbenchMetadata(scope, () => loadWorkbenchMetadata(adapter, scope)),
  ]);

  const assignedItems = await adapter.fetchWorkItems({
    projectId: scope.azureProjectId,
    workItemTypes: metadata.workItemTypes,
    areaPath: filters.areaPath ?? undefined,
    assignedToMe: true,
    limit: WORKBENCH_LIMITS.assignedWorkItems,
  });
  const parentsById = await loadParentSummaries({ items: assignedItems, adapter, scope });
  const today = new Date();
  const selectedSprint = resolveWorkbenchIteration(filters, metadata.iterations);
  const scopedItems = assignedItems
    .filter((item) => isInWorkbenchSprintScope(item, selectedSprint, filters))
    .filter((item) => filters.includeCompleted || !isClosedState(item.state));

  const model = buildMyWorkbenchAnalyticsModel({
    items: assignedItems,
    parentsById,
    filters,
    iterations: metadata.iterations,
    buildWorkItemUrl: (id) => buildWorkItemUrl(adapter, scope, id),
    today,
  });

  return {
    generatedAt: new Date().toISOString(),
    user,
    filters: model.filters,
    filterMetadata: buildWorkbenchMetadata({
      iterations: metadata.iterations,
      areas: metadata.areas,
      states: metadata.states,
      scopedItems,
      parentsById,
      today,
    }),
    cards: model.cards,
    focusList: model.focusList,
    assignedBySprint: model.assignedBySprint,
    charts: model.charts,
    metadata: {
      selectedSprint: {
        mode: model.selectedSprint.mode,
        path: model.selectedSprint.path,
        startDate: model.selectedSprint.startDate,
        finishDate: model.selectedSprint.finishDate,
      },
      counts: model.counts,
      warnings: model.warnings,
    },
  };
}

function normalizeWorkbenchFilters(filters?: Partial<WorkbenchFilters>): WorkbenchFilters {
  const includeCompleted = filters?.includeCompleted ?? DEFAULT_WORKBENCH_FILTERS.includeCompleted;
  return {
    sprintMode: filters?.sprintMode ?? DEFAULT_WORKBENCH_FILTERS.sprintMode,
    iterationPath: filters?.iterationPath?.trim() || null,
    workItemTypes: unique(filters?.workItemTypes ?? DEFAULT_WORKBENCH_FILTERS.workItemTypes),
    states: unique(filters?.states ?? DEFAULT_WORKBENCH_FILTERS.states),
    parentIds: unique(filters?.parentIds ?? DEFAULT_WORKBENCH_FILTERS.parentIds),
    priority: filters?.priority ?? DEFAULT_WORKBENCH_FILTERS.priority,
    areaPath: filters?.areaPath?.trim() || null,
    includeCompleted,
    includeBacklog: filters?.includeBacklog ?? DEFAULT_WORKBENCH_FILTERS.includeBacklog,
  };
}

async function getCachedWorkbenchMetadata(scope: ProjectScope, loader: () => Promise<MetadataCacheValue>) {
  const key = scope.azureProjectId;
  const cached = metadataCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const value = await loader();
  pruneAndSet(metadataCache, key, { expiresAt: Date.now() + METADATA_CACHE_TTL_MS, value }, METADATA_CACHE_MAX_ENTRIES);
  return value;
}

async function loadWorkbenchMetadata(
  adapter: ReturnType<typeof getProjectScopedAzureDevOpsAdapter>,
  scope: ProjectScope,
): Promise<MetadataCacheValue> {
  const [iterations, areas, workItemMetadata] = await Promise.all([
    adapter.fetchIterations({ projectId: scope.azureProjectId }),
    adapter.fetchAreas({ projectId: scope.azureProjectId }),
    adapter.fetchProjectWorkItemMetadata({ projectId: scope.azureProjectId, includeStates: true }),
  ]);
  return {
    iterations,
    areas,
    workItemTypes: workItemMetadata.workItemTypes,
    states: workItemMetadata.states,
  };
}

async function loadParentSummaries(input: {
  items: Requirement[];
  adapter: ReturnType<typeof getProjectScopedAzureDevOpsAdapter>;
  scope: ProjectScope;
}) {
  const parentIds = unique(input.items.flatMap((item) => item.parentLinks ?? []));
  if (!parentIds.length) return new Map<string, { id: string; title: string; url: string | null }>();
  const parents = await input.adapter.fetchWorkItemsByIds({
    projectId: input.scope.azureProjectId,
    workItemIds: parentIds,
  });
  return new Map(parents.map((parent) => [parent.id, {
    id: parent.id,
    title: parent.title,
    url: buildWorkItemUrl(input.adapter, input.scope, parent.id),
  }]));
}

function buildWorkItemUrl(
  adapter: ReturnType<typeof getProjectScopedAzureDevOpsAdapter>,
  scope: ProjectScope,
  id: string,
) {
  try {
    return adapter.buildWorkItemWebUrl({
      projectId: scope.azureProjectId,
      projectName: scope.azureProjectName,
      workItemId: id,
    });
  } catch {
    return null;
  }
}

function unique<T extends string>(values: T[]) {
  return [...new Set(values.filter(Boolean))];
}

function pruneAndSet<V>(
  cache: Map<string, { expiresAt: number; value: V }>,
  key: string,
  entry: { expiresAt: number; value: V },
  maxEntries: number,
) {
  const now = Date.now();
  for (const [existingKey, existingValue] of cache) {
    if (existingValue.expiresAt <= now) cache.delete(existingKey);
  }
  cache.set(key, entry);
  while (cache.size > maxEntries) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}
