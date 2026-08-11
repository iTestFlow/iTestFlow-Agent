import type {
  ArtifactRef,
  RunDetailDeltaDto,
  RunDetailDto,
} from "@/modules/test-execution/report-assembler";

/**
 * Polling cadence for run progress — mirrors the Knowledge Hub curve
 * (knowledge-build.tsx buildJobPollDelay): fast at first, then relaxed, with
 * failure backoff. Pure so it is unit-testable.
 */

const FAILURE_BACKOFF_MS = [5_000, 15_000, 30_000] as const;

export function runPollDelay(elapsedMs: number, consecutiveFailures: number): number {
  if (consecutiveFailures > 0) {
    return FAILURE_BACKOFF_MS[Math.min(consecutiveFailures, FAILURE_BACKOFF_MS.length) - 1];
  }
  if (elapsedMs < 15_000) return 2_000;
  if (elapsedMs < 2 * 60_000) return 5_000;
  return 15_000;
}

/**
 * Merge an incremental poll into the previously rendered run detail. Upserts
 * are keyed by id, so duplicate delivery around the snapshot/cursor boundary
 * is idempotent. Returns null when the delta references a parent the client
 * has never seen (the caller falls back to one full snapshot fetch).
 */
export function mergeRunDetailDelta(
  previous: RunDetailDto,
  delta: RunDetailDeltaDto,
): RunDetailDto | null {
  // Artifacts arrive as the complete (tiny) set each poll — regroup fully.
  const artifactsByStep = new Map<string, ArtifactRef[]>();
  const artifactsByCase = new Map<string, ArtifactRef[]>();
  const runArtifacts: ArtifactRef[] = [];
  for (const artifact of delta.artifacts) {
    if (artifact.stepRunId) {
      const list = artifactsByStep.get(artifact.stepRunId) ?? [];
      list.push(artifact);
      artifactsByStep.set(artifact.stepRunId, list);
    } else if (artifact.caseRunId) {
      const list = artifactsByCase.get(artifact.caseRunId) ?? [];
      list.push(artifact);
      artifactsByCase.set(artifact.caseRunId, list);
    } else {
      runArtifacts.push(artifact);
    }
  }

  const changedStepsByCase = new Map<string, RunDetailDeltaDto["changedSteps"]>();
  for (const step of delta.changedSteps) {
    const list = changedStepsByCase.get(step.caseRunId) ?? [];
    list.push(step);
    changedStepsByCase.set(step.caseRunId, list);
  }
  const changedActionsByStep = new Map<string, RunDetailDeltaDto["changedActions"]>();
  for (const action of delta.changedActions) {
    const list = changedActionsByStep.get(action.stepRunId) ?? [];
    list.push(action);
    changedActionsByStep.set(action.stepRunId, list);
  }

  // A changed step/action must land in a case/step the client already knows
  // (its parent row's change_seq is always <= the child's, so it arrived in
  // this delta or an earlier one). Anything unresolvable means the client
  // state is stale — signal a full refetch instead of guessing.
  const knownCaseIds = new Set(previous.cases.map((entry) => entry.id));
  for (const changed of delta.changedCases) knownCaseIds.add(changed.id);
  if (delta.changedSteps.some((step) => !knownCaseIds.has(step.caseRunId))) return null;

  const changedCaseById = new Map(delta.changedCases.map((entry) => [entry.id, entry]));
  const cases: RunDetailDto["cases"] = previous.cases.map((entry) => {
    const changed = changedCaseById.get(entry.id);
    changedCaseById.delete(entry.id);
    return {
      ...entry,
      ...(changed ?? {}),
      steps: entry.steps,
      artifacts: artifactsByCase.get(entry.id) ?? [],
    };
  });
  for (const added of changedCaseById.values()) {
    cases.push({ ...added, steps: [], artifacts: artifactsByCase.get(added.id) ?? [] });
  }
  cases.sort((left, right) => left.orderIndex - right.orderIndex);

  const knownStepIds = new Set<string>();
  for (const entry of cases) {
    const changedSteps = changedStepsByCase.get(entry.id) ?? [];
    const changedStepById = new Map(changedSteps.map((step) => [step.id, step]));
    entry.steps = entry.steps.map((step) => {
      const changed = changedStepById.get(step.id);
      changedStepById.delete(step.id);
      return { ...step, ...(changed ?? {}), actions: step.actions, artifacts: artifactsByStep.get(step.id) ?? [] };
    });
    for (const added of changedStepById.values()) {
      entry.steps.push({ ...added, actions: [], artifacts: artifactsByStep.get(added.id) ?? [] });
    }
    entry.steps.sort((left, right) => left.orderIndex - right.orderIndex);
    for (const step of entry.steps) knownStepIds.add(step.id);
  }
  if (delta.changedActions.some((action) => !knownStepIds.has(action.stepRunId))) return null;

  for (const entry of cases) {
    for (const step of entry.steps) {
      const changedActions = changedActionsByStep.get(step.id);
      if (!changedActions || changedActions.length === 0) continue;
      const changedActionById = new Map(changedActions.map((action) => [action.id, action]));
      step.actions = step.actions.map((action) => {
        const changed = changedActionById.get(action.id);
        changedActionById.delete(action.id);
        return changed ?? action;
      });
      step.actions.push(...changedActionById.values());
      step.actions.sort((left, right) => left.orderIndex - right.orderIndex);
    }
  }

  return {
    run: {
      ...delta.run,
      // Delta polls skip the approver display-name lookup; keep the known one.
      approvedByName: delta.run.approvedByName ?? previous.run.approvedByName,
    },
    cases,
    runArtifacts,
    defectCandidates: delta.defectCandidates,
    job: delta.job,
    nextCursor: delta.nextCursor,
  };
}
