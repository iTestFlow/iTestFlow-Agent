import type { NaturalPlan } from "@/modules/test-execution/action-schema";

/**
 * localStorage draft + active-run persistence, keyed per project so switching
 * projects never leaks a draft. All access is guarded — storage may be
 * unavailable (SSR, privacy mode) and corrupt payloads must never crash the
 * page. Secret VALUES are deliberately excluded from drafts.
 */

// v2: natural-language plans (Phase 1.5). v1 typed drafts are discarded.
const DRAFT_VERSION = 2;

export type DraftCase = {
  title: string;
  sourceKind: "azure_test_case" | "manual";
  azureTestCaseId: string | null;
  plan: NaturalPlan;
};

export type TestExecutionDraft = {
  version: number;
  savedAt: string;
  storyWorkItemId: string;
  storyTitle: string;
  environmentProfileId: string | null;
  cases: DraftCase[];
};

function draftKey(projectId: string): string {
  return `itestflow.testExecution.draft.${projectId}`;
}
function activeRunKey(projectId: string): string {
  return `itestflow.testExecution.activeRun.${projectId}`;
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function saveDraft(projectId: string, draft: Omit<TestExecutionDraft, "version" | "savedAt">): void {
  const store = storage();
  if (!store || !projectId) return;
  try {
    store.setItem(
      draftKey(projectId),
      JSON.stringify({ ...draft, version: DRAFT_VERSION, savedAt: new Date().toISOString() }),
    );
  } catch {
    // Quota or serialization issues must never break the editor.
  }
}

export function loadDraft(projectId: string): TestExecutionDraft | null {
  const store = storage();
  if (!store || !projectId) return null;
  try {
    const raw = store.getItem(draftKey(projectId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as TestExecutionDraft;
    if (parsed?.version !== DRAFT_VERSION || !Array.isArray(parsed.cases)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearDraft(projectId: string): void {
  const store = storage();
  if (!store || !projectId) return;
  try {
    store.removeItem(draftKey(projectId));
  } catch {
    // ignore
  }
}

export function saveActiveRunId(projectId: string, runId: string | null): void {
  const store = storage();
  if (!store || !projectId) return;
  try {
    if (runId) store.setItem(activeRunKey(projectId), runId);
    else store.removeItem(activeRunKey(projectId));
  } catch {
    // ignore
  }
}

export function loadActiveRunId(projectId: string): string | null {
  const store = storage();
  if (!store || !projectId) return null;
  try {
    return store.getItem(activeRunKey(projectId));
  } catch {
    return null;
  }
}
