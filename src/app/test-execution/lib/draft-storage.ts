import type { ExecutionDraft } from "./execution-draft";

/* --------------------------------------------------------------------------
 * Per-project localStorage draft so a refresh never loses authored work.
 * Secret VALUES are deliberately stripped before save: only titles and saved
 * references survive; a typed-but-not-yet-run secret must be re-entered.
 * Every access is guarded — quota, SSR, and privacy mode must never crash
 * the editor.
 * ------------------------------------------------------------------------ */

const DRAFT_VERSION = 1;

type StoredDraft = { version: number; savedAt: string; draft: ExecutionDraft };

function draftKey(projectId: string): string {
  return `itestflow.testExecution.draft.${projectId}`;
}

function withoutSecretValues(draft: ExecutionDraft): ExecutionDraft {
  return {
    ...draft,
    setup: {
      ...draft.setup,
      testData: draft.setup.testData.map((entry) =>
        entry.isSecret && entry.value ? { ...entry, value: "" } : entry,
      ),
    },
  };
}

export function saveDraft(projectId: string, draft: ExecutionDraft): void {
  try {
    const stored: StoredDraft = { version: DRAFT_VERSION, savedAt: new Date().toISOString(), draft: withoutSecretValues(draft) };
    window.localStorage.setItem(draftKey(projectId), JSON.stringify(stored));
  } catch {
    // Storage may be full or unavailable; the in-memory draft still works.
  }
}

export function loadDraft(projectId: string): ExecutionDraft | null {
  try {
    const raw = window.localStorage.getItem(draftKey(projectId));
    if (!raw) return null;
    const stored = JSON.parse(raw) as StoredDraft;
    if (stored?.version !== DRAFT_VERSION || !stored.draft?.setup || !Array.isArray(stored.draft.cases)) return null;
    return stored.draft;
  } catch {
    return null;
  }
}

export function clearDraft(projectId: string): void {
  try {
    window.localStorage.removeItem(draftKey(projectId));
  } catch {
    // Ignore storage failures on cleanup.
  }
}
