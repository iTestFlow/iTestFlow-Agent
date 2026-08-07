import type { RunDetailRows } from "./run.service";

/**
 * Pure composition of the run detail DTO — the polling target during
 * execution and the data source of the native report page. Input rows come
 * from loadRunDetailRows (already scope-checked); output is JSON-safe and
 * contains no secrets (step rows persist placeholders only) and no storage
 * keys (artifact downloads go through the authorized route by id).
 */

export type RunDetailDto = {
  run: {
    id: string;
    status: string;
    outcome: string | null;
    storyWorkItemId: string | null;
    storyTitle: string | null;
    environmentProfileId: string | null;
    envConfig: unknown;
    summary: unknown;
    planSchemaVersion: string;
    approvedBy: string;
    approvedAt: string;
    startedAt: string | null;
    finishedAt: string | null;
    errorMessage: string | null;
    createdAt: string;
  };
  cases: {
    id: string;
    orderIndex: number;
    title: string;
    sourceKind: string;
    sourceSnapshotId: string | null;
    compileSource: string;
    compilePromptVersion: string | null;
    compileModel: string | null;
    status: string;
    outcome: string | null;
    errorMessage: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    steps: {
      id: string;
      orderIndex: number;
      action: unknown;
      status: string;
      outcome: string | null;
      observation: unknown;
      errorMessage: string | null;
      startedAt: string | null;
      finishedAt: string | null;
      artifacts: ArtifactRef[];
    }[];
    artifacts: ArtifactRef[];
  }[];
  runArtifacts: ArtifactRef[];
  defectCandidates: {
    id: string;
    caseRunId: string;
    status: string;
    draft: unknown;
    evidence: unknown;
    updatedAt: string;
  }[];
  job: { id: string; status: string; cancelRequestedAt: string | null } | null;
};

export type ArtifactRef = {
  id: string;
  kind: string;
  mimeType: string;
  byteSize: number;
  fileName: string;
  caseRunId: string | null;
  stepRunId: string | null;
  createdAt: string;
};

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function strOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
function num(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0) || 0;
}

export function assembleRunDetail(rows: RunDetailRows): RunDetailDto | null {
  const run = rows.run;
  if (!run) return null;

  const artifacts: ArtifactRef[] = rows.artifacts.map((row) => ({
    id: str(row.id),
    kind: str(row.kind),
    mimeType: str(row.mime_type),
    byteSize: num(row.byte_size),
    fileName: str(row.file_name),
    caseRunId: strOrNull(row.case_run_id),
    stepRunId: strOrNull(row.step_run_id),
    createdAt: str(row.created_at),
  }));
  const artifactsByStep = new Map<string, ArtifactRef[]>();
  const artifactsByCase = new Map<string, ArtifactRef[]>();
  const runLevelArtifacts: ArtifactRef[] = [];
  for (const artifact of artifacts) {
    if (artifact.stepRunId) {
      const list = artifactsByStep.get(artifact.stepRunId) ?? [];
      list.push(artifact);
      artifactsByStep.set(artifact.stepRunId, list);
    } else if (artifact.caseRunId) {
      const list = artifactsByCase.get(artifact.caseRunId) ?? [];
      list.push(artifact);
      artifactsByCase.set(artifact.caseRunId, list);
    } else {
      runLevelArtifacts.push(artifact);
    }
  }

  const stepsByCase = new Map<string, RunDetailDto["cases"][number]["steps"]>();
  for (const row of rows.steps) {
    const caseId = str(row.case_run_id);
    const list = stepsByCase.get(caseId) ?? [];
    list.push({
      id: str(row.id),
      orderIndex: num(row.order_index),
      action: row.action_json,
      status: str(row.status),
      outcome: strOrNull(row.outcome),
      observation: row.observation_json,
      errorMessage: strOrNull(row.error_message),
      startedAt: strOrNull(row.started_at),
      finishedAt: strOrNull(row.finished_at),
      artifacts: artifactsByStep.get(str(row.id)) ?? [],
    });
    stepsByCase.set(caseId, list);
  }

  return {
    run: {
      id: str(run.id),
      status: str(run.status),
      outcome: strOrNull(run.outcome),
      storyWorkItemId: strOrNull(run.story_work_item_id),
      storyTitle: strOrNull(run.story_title),
      environmentProfileId: strOrNull(run.environment_profile_id),
      envConfig: sanitizeEnvConfig(run.env_config_json),
      summary: run.summary_json,
      planSchemaVersion: str(run.plan_schema_version),
      approvedBy: str(run.approved_by),
      approvedAt: str(run.approved_at),
      startedAt: strOrNull(run.started_at),
      finishedAt: strOrNull(run.finished_at),
      errorMessage: strOrNull(run.error_message),
      createdAt: str(run.created_at),
    },
    cases: rows.cases.map((row) => ({
      id: str(row.id),
      orderIndex: num(row.order_index),
      title: str(row.title),
      sourceKind: str(row.source_kind),
      sourceSnapshotId: strOrNull(row.source_snapshot_id),
      compileSource: str(row.compile_source),
      compilePromptVersion: strOrNull(row.compile_prompt_version),
      compileModel: strOrNull(row.compile_model),
      status: str(row.status),
      outcome: strOrNull(row.outcome),
      errorMessage: strOrNull(row.error_message),
      startedAt: strOrNull(row.started_at),
      finishedAt: strOrNull(row.finished_at),
      steps: stepsByCase.get(str(row.id)) ?? [],
      artifacts: artifactsByCase.get(str(row.id)) ?? [],
    })),
    runArtifacts: runLevelArtifacts,
    defectCandidates: rows.candidates.map((row) => ({
      id: str(row.id),
      caseRunId: str(row.case_run_id),
      status: str(row.status),
      draft: row.draft_json,
      evidence: row.evidence_json,
      updatedAt: str(row.updated_at),
    })),
    job: rows.job,
  };
}

/** The env config is non-secret by construction; drop the login plan anyway —
 * the report never needs it and its values (though placeholder-only) are noise. */
function sanitizeEnvConfig(envConfig: unknown): unknown {
  if (envConfig && typeof envConfig === "object") {
    const { loginPlan: _omitted, ...rest } = envConfig as Record<string, unknown>;
    return { ...rest, hasLoginPlan: Boolean(_omitted) };
  }
  return envConfig;
}
