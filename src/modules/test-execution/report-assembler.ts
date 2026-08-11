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
    approvedByName: string | null;
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
      actions: ActionRunRef[];
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

export type ActionRunRef = {
  id: string;
  orderIndex: number;
  layer: string;
  actionType: string;
  safetyClass: string;
  request: unknown;
  status: string;
  observation: unknown;
  errorCategory: string | null;
  errorMessage: string | null;
  startedAt: string;
  finishedAt: string | null;
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

  const actionsByStep = new Map<string, ActionRunRef[]>();
  for (const row of rows.actions ?? []) {
    const stepId = str(row.step_run_id);
    const list = actionsByStep.get(stepId) ?? [];
    list.push({
      id: str(row.id),
      orderIndex: num(row.order_index),
      layer: str(row.layer),
      actionType: str(row.action_type),
      safetyClass: str(row.safety_class),
      request: redactSensitiveFields(row.request_json),
      status: str(row.status),
      observation: redactSensitiveFields(row.observation_json),
      errorCategory: strOrNull(row.error_category),
      errorMessage: strOrNull(row.error_message),
      startedAt: str(row.started_at),
      finishedAt: strOrNull(row.finished_at),
    });
    actionsByStep.set(stepId, list);
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
      actions: actionsByStep.get(str(row.id)) ?? [],
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
      approvedByName: rows.approvedByName,
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

/**
 * Report an explicit allowlist. Secrets are stored separately, but target
 * hosts, database identities, test users, and execution notes are still
 * connection-sensitive metadata that ordinary report readers do not need.
 */
function sanitizeEnvConfig(envConfig: unknown): unknown {
  if (!envConfig || typeof envConfig !== "object" || Array.isArray(envConfig)) return {};
  const config = envConfig as Record<string, unknown>;
  const api = objectOrNull(config.api);
  const database = objectOrNull(config.database);
  const auth = objectOrNull(api?.auth);
  return {
    initialUrl: typeof config.initialUrl === "string" ? config.initialUrl : "",
    allowedOrigin: typeof config.allowedOrigin === "string" ? config.allowedOrigin : "",
    viewportWidth: num(config.viewportWidth),
    viewportHeight: num(config.viewportHeight),
    headless: config.headless !== false,
    defaultTimeoutMs: num(config.defaultTimeoutMs),
    navigationTimeoutMs: num(config.navigationTimeoutMs),
    evidenceLevel: str(config.evidenceLevel),
    loginMode: str(config.loginMode),
    hasLoginPlan: Boolean(config.loginPlan),
    testUserCount: Array.isArray(config.users) ? config.users.length : 0,
    hasApi: Boolean(api),
    api: api
      ? {
          authType: str(auth?.type),
          hasContract: Boolean(api.contract),
          requestTimeoutMs: num(api.requestTimeoutMs),
          mutationMode: str(api.mutationMode),
        }
      : null,
    hasDatabase: Boolean(database),
    database: database
      ? {
          driver: str(database.driver),
          tlsMode: str(database.tlsMode),
          accessMode: str(database.accessMode),
          schemaCount: Array.isArray(database.schemas) ? database.schemas.length : 0,
          connectTimeoutMs: num(database.connectTimeoutMs),
          statementTimeoutMs: num(database.statementTimeoutMs),
        }
      : null,
  };
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

const SENSITIVE_KEY = /(?:authorization|cookie|password|passwd|secret|token|api[-_]?key|credential)/i;

function redactSensitiveFields(value: unknown, depth = 0): unknown {
  if (depth > 12) return "<truncated>";
  if (Array.isArray(value)) return value.map((entry) => redactSensitiveFields(entry, depth + 1));
  const object = objectOrNull(value);
  if (!object) return value;
  return Object.fromEntries(
    Object.entries(object).map(([key, child]) => [
      key,
      SENSITIVE_KEY.test(key) ? "<redacted>" : redactSensitiveFields(child, depth + 1),
    ]),
  );
}
