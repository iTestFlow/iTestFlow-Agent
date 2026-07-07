"use client";

import { useEffect, useState } from "react";

import { isRequirementLikeType, postJson } from "@/components/workflow/test-intelligence-shared";
import type { ApiState } from "@/components/workflow/test-intelligence-types";
import { WorkItemSummaryCard, type WorkItemSummary } from "@/components/workflow/work-item-summary-card";
import type { ActiveProjectScope } from "@/shared/lib/active-project";
import { caughtErrorMessage } from "@/shared/lib/api-error-message";

/**
 * Shared Azure DevOps work-item lookup: a debounced "load by ID" hook plus a
 * drop-in preview component built on {@link WorkItemSummaryCard}. Extracted so
 * the workflow clients (Requirement Analysis, Test Case Design, Test Coverage
 * Matrix) get the same "confirm the entered ID" affordance that Create Bug and
 * Test Execution Effort already have. Purely a preview — it never gates any
 * action; the caller keeps owning its `targetWorkItemId` and submit logic.
 */

const WORK_ITEM_LOOKUP_DEBOUNCE_MS = 700;

/** Shared title for the work-item ID inputs in the workflow clients. */
export const WORK_ITEM_ID_TITLE = "Work Item ID";

/** Shared placeholder for the work-item ID inputs in the workflow clients. */
export const WORK_ITEM_ID_PLACEHOLDER = "e.g. 123456";

/** Structural superset of {@link WorkItemSummary} mirroring /work-item-details. */
export type LoadedWorkItem = WorkItemSummary & {
  state?: string;
  description?: string;
  acceptanceCriteria?: string;
};

export function useWorkItemLookup({
  scope,
  workItemId,
  debounceMs = WORK_ITEM_LOOKUP_DEBOUNCE_MS,
  errorMessage = "Work item lookup failed.",
  invalidIdMessage = "Enter a valid numeric work item ID.",
  enabled = true,
}: {
  scope: ActiveProjectScope | null;
  workItemId: string;
  debounceMs?: number;
  errorMessage?: string;
  invalidIdMessage?: string;
  /** When false, the hook stays idle and performs no lookup — used when a caller passes a shared lookup down instead. */
  enabled?: boolean;
}): ApiState<LoadedWorkItem> {
  const [state, setState] = useState<ApiState<LoadedWorkItem>>({ loading: false, error: null, data: null });
  const trimmed = workItemId.trim();

  useEffect(() => {
    if (!enabled || !scope || !trimmed) {
      setState({ loading: false, error: null, data: null });
      return;
    }
    if (!/^\d+$/.test(trimmed)) {
      setState({ loading: false, error: invalidIdMessage, data: null });
      return;
    }

    let cancelled = false;
    const timeoutId = window.setTimeout(() => {
      setState({ loading: true, error: null, data: null });
      void postJson<{ workItem: LoadedWorkItem }>("/api/azure-devops/work-item-details", { scope, workItemId: trimmed })
        .then((data) => {
          if (!cancelled) setState({ loading: false, error: null, data: data.workItem });
        })
        .catch((error: unknown) => {
          if (!cancelled) {
            setState({ loading: false, error: caughtErrorMessage(error, errorMessage), data: null });
          }
        });
    }, debounceMs);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [enabled, scope, trimmed, debounceMs, errorMessage, invalidIdMessage]);

  return state;
}

export function WorkItemPreview({
  scope,
  workItemId,
  className,
  debounceMs,
  emptyText,
  loadingText,
  invalidNote = "This work item is not a typical story/requirement type.",
  isValidType = isRequirementLikeType,
  lookup: externalLookup,
}: {
  scope: ActiveProjectScope | null;
  workItemId: string;
  className?: string;
  debounceMs?: number;
  emptyText?: string;
  loadingText?: string;
  invalidNote?: string;
  isValidType?: (workItemType: string) => boolean;
  /**
   * Optional caller-owned lookup state. When provided, the preview renders it
   * directly and skips its own fetch — lets a page share one lookup between
   * this preview and, e.g., a review-step header that also needs the title.
   */
  lookup?: ApiState<LoadedWorkItem>;
}) {
  const internalLookup = useWorkItemLookup({ scope, workItemId, debounceMs, enabled: externalLookup === undefined });
  const lookup = externalLookup ?? internalLookup;
  const valid = lookup.data ? isValidType(lookup.data.workItemType) : true;

  return (
    <WorkItemSummaryCard
      story={lookup.data}
      loading={lookup.loading}
      error={lookup.error}
      valid={valid}
      invalidNote={invalidNote}
      emptyText={emptyText}
      loadingText={loadingText}
      className={className}
    />
  );
}
