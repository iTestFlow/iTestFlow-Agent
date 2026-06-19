"use client";

import { useState } from "react";
import { Loader2, Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Callout } from "@/components/qa/callout";
import { ConfirmationDialog } from "@/components/qa/confirmation-dialog";
import { useUnsavedChangesGuard } from "@/components/navigation/unsaved-changes-provider";
import {
  ErrorBlock,
  SectionCard,
  SuggestedAdditionsPublishResultSummary,
  normalizeTestCasePriority,
  postJson,
} from "@/components/workflow/test-intelligence-shared";
import type {
  ApiState,
  GeneratedTestCase,
  SuggestedAdditionsPublishResult,
} from "@/components/workflow/test-intelligence-types";
import type { ActiveProjectScope } from "@/shared/lib/active-project";

/* Creates the selected suggested test cases in Azure DevOps and links them to
 * the target user story. Behaviour and API contract are unchanged. */

export function SuggestedAdditionsPublishPanel({
  scope,
  targetWorkItemId,
  testCases,
  invalidCaseCount,
  onPublished,
  analyticsRunId,
  itemsGenerated,
  itemsEdited,
}: {
  scope: ActiveProjectScope | null;
  targetWorkItemId: string;
  testCases: GeneratedTestCase[];
  invalidCaseCount: number;
  onPublished: () => void;
  analyticsRunId?: string;
  itemsGenerated: number;
  itemsEdited: number;
}) {
  const [state, setState] = useState<ApiState<SuggestedAdditionsPublishResult>>({ loading: false, error: null, data: null });
  useUnsavedChangesGuard({ dirty: false, busy: state.loading });

  async function publish() {
    if (!scope || !targetWorkItemId || !testCases.length || state.loading) return;
    setState({ loading: true, error: null, data: null });
    try {
      const data = await postJson<SuggestedAdditionsPublishResult>("/api/test-coverage-matrix/suggested-additions/publish", {
        scope,
        analyticsRunId,
        itemsGenerated,
        itemsEdited,
        targetWorkItemId,
        testCases: testCases.map((testCase) => ({
          ...testCase,
          localId: testCase.id,
          targetUserStoryId: targetWorkItemId,
          priority: normalizeTestCasePriority(testCase.priority),
          steps: testCase.steps.map((step) => ({ action: step.action, expectedResult: step.expectedResult })),
          testType: testCase.type,
        })),
      });
      setState({ loading: false, error: null, data });
      if (data.results.length > 0 && data.results.every((result) => result.success)) {
        onPublished();
      }
    } catch (error) {
      setState({ loading: false, error: error instanceof Error ? error.message : "Suggested additions publish failed.", data: null });
    }
  }

  const disabled = !scope || !targetWorkItemId || !testCases.length || invalidCaseCount > 0 || state.loading;

  return (
    <SectionCard
      title="Add Suggested Additions to Azure"
      description="Create the suggested Azure Test Case work items and link them to the selected user story."
    >
      <div className="space-y-4 p-4">
        {state.error ? <ErrorBlock message={state.error} /> : null}
        {invalidCaseCount > 0 ? (
          <Callout tone="warning">
            Resolve validation issues in the {invalidCaseCount} selected suggested test case{invalidCaseCount === 1 ? "" : "s"} before creating them.
          </Callout>
        ) : null}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-sm leading-6 text-muted-foreground">
            {testCases.length} suggested test case{testCases.length === 1 ? "" : "s"} will be created and linked to user story {targetWorkItemId || "the selected story"}.
          </div>
          <ConfirmationDialog
            trigger={
              <Button disabled={disabled}>
                {state.loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                {state.loading ? "Adding..." : "Add to Azure"}
              </Button>
            }
            title="Add suggested test cases to Azure?"
            description={
              <div className="space-y-1">
                <p>Project: {scope?.azureProjectName ?? "Selected Azure DevOps project"}</p>
                <p>User story: {targetWorkItemId}</p>
                <p>Suggested test cases: {testCases.length}</p>
                <p>Each created test case will be linked to this user story.</p>
              </div>
            }
            confirmLabel="Create and link cases"
            onConfirm={publish}
          />
        </div>
        {state.data ? <SuggestedAdditionsPublishResultSummary data={state.data} /> : null}
      </div>
    </SectionCard>
  );
}
