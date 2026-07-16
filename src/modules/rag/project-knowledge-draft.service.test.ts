import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  createId: vi.fn(),
  nowIso: vi.fn(),
  sqlAll: vi.fn(),
  sqlGet: vi.fn(),
  sqlRun: vi.fn(),
  withTransaction: vi.fn(),
}));
const audit = vi.hoisted(() => ({ writeAuditLogTransactional: vi.fn() }));
const compiled = vi.hoisted(() => ({
  recordProjectKnowledgeRevision: vi.fn(),
  runProjectKnowledgeLint: vi.fn(),
}));
const lock = vi.hoisted(() => ({ acquireProjectKnowledgeLock: vi.fn() }));
const migration = vi.hoisted(() => ({ backfillProjectKnowledgeCompilerFoundation: vi.fn() }));

vi.mock("@/modules/shared/infrastructure/database/db", () => database);
vi.mock("@/modules/audit/audit.service", () => audit);
vi.mock("./project-knowledge-compiled.service", () => compiled);
vi.mock("./project-knowledge-lock", () => lock);
vi.mock("./project-knowledge-migration.service", () => migration);
vi.mock("./context-chatbot-retrieval.service", () => ({ refreshProjectKnowledgeSearchIndex: vi.fn() }));

import { projectScope } from "@/test/factories";
import { AppErrorCode } from "@/modules/shared/errors/app-error";
import {
  PROJECT_KNOWLEDGE_COMPILER_CONTRACT_VERSION,
  PROJECT_KNOWLEDGE_WORDING_VERSION,
  computeProjectKnowledgeHashes,
  computeProjectKnowledgeSourceFingerprint,
  hashCanonicalValue,
} from "./project-knowledge-contracts";
import {
  beginProjectKnowledgeDraft,
  abandonProjectKnowledgeDraft,
  completeProjectKnowledgeDraft,
  computeProjectKnowledgePipelineWarnings,
  getProjectKnowledgeDraft,
  getProjectKnowledgeDraftConflicts,
  listProjectKnowledgeDrafts,
  loadProjectKnowledgeManualBatchResults,
  publishProjectKnowledgeDraft,
  storeProjectKnowledgeManualDraftBatches,
} from "./project-knowledge-draft.service";

const scope = projectScope();
const emptyKnowledge = {
  modules: [],
  businessRules: [],
  stateTransitions: [],
  glossary: [],
  crossDependencies: [],
};

function draftRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "draft-child",
    generation_mode: "manual",
    compilation_mode: "full",
    status: "awaiting_input",
    status_reason: null,
    parent_draft_id: "draft-parent",
    rebase_depth: 1,
    base_revision_id: "revision-1",
    source_manifest_json: [],
    source_fingerprint: computeProjectKnowledgeSourceFingerprint([]),
    compiler_contract_version: PROJECT_KNOWLEDGE_COMPILER_CONTRACT_VERSION,
    wording_version: PROJECT_KNOWLEDGE_WORDING_VERSION,
    provider: null,
    model_name: null,
    raw_output: null,
    proposed_knowledge_json: null,
    operations_json: [],
    generation_data_json: {},
    blockers_json: [],
    metrics_json: {},
    semantic_hash: null,
    provenance_hash: null,
    pending_drift: false,
    heartbeat_at: "2026-07-12T12:00:00.000Z",
    review_ready_at: null,
    created_by: "owner-1",
    created_at: "2026-07-12T12:00:00.000Z",
    updated_at: "2026-07-12T12:00:00.000Z",
    published_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  database.createId.mockReturnValue("generated-id");
  database.nowIso.mockReturnValue("2026-07-12T12:30:00.000Z");
  database.sqlRun.mockResolvedValue(1);
  database.sqlAll.mockResolvedValue([]);
  database.sqlGet.mockResolvedValue(undefined);
  database.withTransaction.mockImplementation(async (callback: (client: object) => unknown) => callback({}));
  audit.writeAuditLogTransactional.mockResolvedValue(undefined);
  lock.acquireProjectKnowledgeLock.mockResolvedValue(undefined);
  migration.backfillProjectKnowledgeCompilerFoundation.mockResolvedValue(undefined);
});

describe("draft evidence recovery", () => {
  const manifest = [{
    sourceSnapshotId: "snapshot-42",
    sourceWorkItemId: "42",
    workItemType: "User Story",
    contentHash: "hash-42",
    adoRevision: 1,
    sourceUpdatedAt: "2026-07-12T12:00:00.000Z",
    capturedAt: "2026-07-12T12:00:00.000Z",
  }];
  const manifestRow = [{
    source_snapshot_id: "snapshot-42",
    source_work_item_id: "42",
    work_item_type: "User Story",
    content_hash: "hash-42",
    ado_revision: 1,
    source_updated_at: "2026-07-12T12:00:00.000Z",
    captured_at: "2026-07-12T12:00:00.000Z",
  }];
  const proposal = {
    modules: [{
      id: "checkout",
      name: "Checkout",
      description: "Customers complete checkout.",
      sourceWorkItemIds: ["42"],
      evidence: "Customers complete checkout securely.",
      evidenceRefs: [{
        sourceSnapshotId: "snapshot-42",
        sourceWorkItemId: "42",
        sourceField: "description" as const,
        quote: "Customers complete checkout securely.",
        locator: { projectionVersion: "plain-text-v1", citationHandle: "cite_checkout", start: 0, end: 37 },
        origin: "generated_v4" as const,
        verification: "exact" as const,
      }],
    }],
    businessRules: [],
    stateTransitions: [],
    glossary: [],
    crossDependencies: [],
  };
  function prepareCompletion(fields: Record<string, unknown>) {
    const row = draftRow({
      generation_mode: "automatic",
      status: "generating",
      source_manifest_json: manifest,
      source_fingerprint: computeProjectKnowledgeSourceFingerprint(manifest),
    });
    database.sqlGet.mockImplementation(async (sql: string) =>
      sql.includes("project_knowledge_drafts") ? row : undefined);
    database.sqlAll.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT id, azure_work_item_id, fields_json")) {
        return [{ id: "snapshot-42", azure_work_item_id: "42", fields_json: fields }];
      }
      if (sql.includes("JOIN azure_devops_work_item_snapshots")) return manifestRow;
      return [];
    });
  }

  it("validates frozen v4 evidence once and persists ready_to_publish", async () => {
    prepareCompletion({ description: "Customers complete checkout securely." });
    await completeProjectKnowledgeDraft({
      scope,
      draftId: "draft-child",
      provider: "openai",
      model: "model",
      rawOutput: JSON.stringify(proposal),
      knowledgeBase: proposal,
    });

    const update = database.sqlRun.mock.calls.find(([sql]) => String(sql).includes("SET status = @status"));
    expect(update?.[1]).toMatchObject({ status: "ready_to_publish", statusReason: null });
    expect(update?.[0]).toContain("review_ready_at = CASE");
    expect(update?.[1]).toMatchObject({ reviewReady: true, updatedAt: "2026-07-12T12:30:00.000Z" });
    const metrics = JSON.parse(String((update?.[1] as { metricsJson: string }).metricsJson));
    expect(metrics).toMatchObject({
      quoteExactCount: 1,
      omittedEntryCount: 0,
      autoEvidenceRepairAttemptedCount: 0,
      autoEvidenceRepairCount: 0,
      autoEvidenceRepairUnresolvedCount: 0,
    });
    const persisted = JSON.parse(String((update?.[1] as { proposedKnowledgeJson: string }).proposedKnowledgeJson));
    expect(persisted.modules[0].evidenceRefs).toHaveLength(1);
  });

  it("omits unsupported entries without creating evidence blockers", async () => {
    prepareCompletion({ description: "Customers complete checkout securely." });
    await completeProjectKnowledgeDraft({
      scope,
      draftId: "draft-child",
      provider: "openai",
      model: "model",
      rawOutput: JSON.stringify(proposal),
      knowledgeBase: {
        ...proposal,
        modules: [
          ...proposal.modules,
          {
            id: "unsupported",
            name: "Unsupported",
            description: "No immutable citation.",
            sourceWorkItemIds: ["42"],
            evidence: "No immutable citation.",
          },
        ],
      },
    });

    const update = database.sqlRun.mock.calls.find(([sql]) => String(sql).includes("SET status = @status"));
    expect(update?.[1]).toMatchObject({ status: "ready_to_publish", statusReason: null });
    const blockers = JSON.parse(String((update?.[1] as { blockersJson: string }).blockersJson));
    const persisted = JSON.parse(String((update?.[1] as { proposedKnowledgeJson: string }).proposedKnowledgeJson));
    const metrics = JSON.parse(String((update?.[1] as { metricsJson: string }).metricsJson));
    expect(blockers).toEqual([]);
    expect(persisted.modules.map((entry: { id: string }) => entry.id)).toEqual(["checkout"]);
    expect(metrics.omittedEntryCount).toBe(1);
  });

  it("fails safely when every non-empty entry is unsupported", async () => {
    prepareCompletion({ description: "Actual immutable checkout content." });
    await expect(completeProjectKnowledgeDraft({
      scope,
      draftId: "draft-child",
      provider: "openai",
      model: "model",
      rawOutput: "{}",
      knowledgeBase: {
        ...emptyKnowledge,
        modules: [{
          id: "unsupported",
          name: "Unsupported",
          description: "No immutable citation.",
          sourceWorkItemIds: ["42"],
          evidence: "No immutable citation.",
        }],
      },
    })).rejects.toMatchObject({
      code: AppErrorCode.SchemaValidation,
      userMessage: "The build produced no grounded knowledge. The active publication was not changed.",
    });

    expect(database.sqlRun.mock.calls.some(([sql]) => String(sql).includes("SET status = @status"))).toBe(false);
  });

  it("consolidates only normalization-equivalent identities at the completion boundary", async () => {
    prepareCompletion({ description: "Customers complete checkout securely." });

    await completeProjectKnowledgeDraft({
      scope,
      draftId: "draft-child",
      provider: "openai",
      model: "model",
      rawOutput: "{}",
      recoverMissingEvidenceRefs: false,
      metrics: { automaticDuplicateConsolidationCount: 4 },
      knowledgeBase: {
        ...emptyKnowledge,
        modules: [
          proposal.modules[0],
          { ...proposal.modules[0], id: "Checkout", name: " checkout " },
        ],
      },
    });

    const update = database.sqlRun.mock.calls.find(([sql]) => String(sql).includes("SET status = @status"));
    const persisted = JSON.parse(String((update?.[1] as { proposedKnowledgeJson: string }).proposedKnowledgeJson));
    const metrics = JSON.parse(String((update?.[1] as { metricsJson: string }).metricsJson));

    expect(persisted.modules).toHaveLength(1);
    expect(persisted.modules[0]).toMatchObject({
      id: "checkout",
      sourceWorkItemIds: ["42"],
      evidence: "Customers complete checkout securely.",
    });
    expect(metrics.automaticDuplicateConsolidationCount).toBe(5);
    expect(metrics.conflictCount).toBe(0);
  });

  it("blocks only on grounded semantic conflicts", async () => {
    prepareCompletion({
      title: "Routes card payments.",
      description: "Routes bank transfers.",
    });

    await completeProjectKnowledgeDraft({
      scope,
      draftId: "draft-child",
      provider: "openai",
      model: "model",
      rawOutput: "{}",
      knowledgeBase: {
        ...emptyKnowledge,
        glossary: [
          {
            term: "Payment Gateway",
            type: "system",
            definition: "Routes card payments.",
            sourceWorkItemIds: ["42"],
            evidence: "Routes card payments.",
            evidenceRefs: [{
              sourceSnapshotId: "snapshot-42",
              sourceWorkItemId: "42",
              sourceField: "title",
              quote: "Routes card payments.",
              origin: "generated_v4",
              verification: "exact",
            }],
          },
          {
            term: "Payment Gateway",
            type: "system",
            definition: "Routes bank transfers.",
            sourceWorkItemIds: ["42"],
            evidence: "Routes bank transfers.",
            evidenceRefs: [{
              sourceSnapshotId: "snapshot-42",
              sourceWorkItemId: "42",
              sourceField: "description",
              quote: "Routes bank transfers.",
              origin: "generated_v4",
              verification: "exact",
            }],
          },
        ],
      },
    });

    const update = database.sqlRun.mock.calls.find(([sql]) => String(sql).includes("SET status = @status"));
    const blockers = JSON.parse(String((update?.[1] as { blockersJson: string }).blockersJson));
    expect(blockers).toEqual([expect.objectContaining({
      type: "hard_conflict",
      affectedCategory: "glossary",
      participants: expect.arrayContaining([
        expect.objectContaining({ sourceWorkItemIds: ["42"] }),
        expect.objectContaining({ sourceWorkItemIds: ["42"] }),
      ]),
    })]);
    expect(blockers.some((blocker: { type: string }) => blocker.type === "missing_evidence_refs")).toBe(false);
  });

});

describe("compact conflict pagination", () => {
  it("returns at most 50 compact cards from a 1,000-conflict draft", async () => {
    const blockers = Array.from({ length: 1_000 }, (_, index) => {
      const entryKey = `module-${index + 1}`;
      const evidenceRef = {
        sourceSnapshotId: `snapshot-${index + 1}`,
        sourceWorkItemId: `${index + 1}`,
        sourceField: "description" as const,
        quote: `Supported statement ${index + 1}`,
        origin: "generated_v4" as const,
        verification: "exact" as const,
      };
      const entry = {
        id: entryKey,
        name: `Module ${index + 1}`,
        description: `Supported statement ${index + 1}`,
        sourceWorkItemIds: [`${index + 1}`],
        evidence: `Supported statement ${index + 1}`,
        evidenceRefs: [evidenceRef],
      };
      return {
        id: `conflict-${index + 1}`,
        type: "hard_conflict",
        category: "hard_conflict",
        entryKey,
        message: "Choose a supported version.",
        affectedCategory: "module",
        identityKey: `identity:module:${entryKey}`,
        subject: entryKey,
        conflictType: "duplicate_identity",
        evidenceIdentical: false,
        participants: [{
          participantId: `participant-${index + 1}`,
          category: "module",
          entryKey,
          entry,
          projection: { name: entry.name, description: entry.description },
          semanticHash: `hash-${index + 1}`,
          evidenceRefs: [evidenceRef],
          sourceSnapshotIds: [evidenceRef.sourceSnapshotId],
          sourceWorkItemIds: [evidenceRef.sourceWorkItemId],
          evidence: evidenceRef.quote,
        }],
      };
    });
    database.sqlGet.mockResolvedValue(draftRow({
      status: "blocked",
      blockers_json: blockers,
    }));

    const result = await getProjectKnowledgeDraftConflicts({
      scope,
      draftId: "draft-child",
      page: 20,
      pageSize: 500,
    });

    expect(result).toMatchObject({
      counts: { total: 1_000, resolved: 0, remaining: 1_000 },
      page: 20,
      pageSize: 50,
      pageCount: 20,
    });
    expect(result.conflicts).toHaveLength(50);
    expect(result.conflicts[0].conflictId).toBe("conflict-951");
    expect(result.conflicts[49].conflictId).toBe("conflict-1000");
    expect(result.conflicts[0].participants[0]).toEqual({
      participantId: "participant-951",
      entryKey: "module-951",
      fields: { name: "Module 951", description: "Supported statement 951" },
      evidence: [{
        sourceField: "description",
        quote: "Supported statement 951",
        sourceWorkItemId: "951",
      }],
    });
  });
});

describe("manual draft batch persistence", () => {
  it("initializes fresh manual batches without inheriting an older draft's answers", async () => {
    const row = draftRow();
    database.sqlGet.mockResolvedValue(row);
    const promptHash = hashCanonicalValue({ system: "system", user: "user" });
    database.sqlAll.mockResolvedValue([{
      prompt_hash: promptHash,
      compiler_contract_version: PROJECT_KNOWLEDGE_COMPILER_CONTRACT_VERSION,
      raw_output: "{}",
      validated_output: emptyKnowledge,
    }]);

    const result = await storeProjectKnowledgeManualDraftBatches({
      scope,
      draftId: "draft-child",
      batches: [{ batchIndex: 1, systemPrompt: "system", userPrompt: "user" }],
    });

    expect(result.carriedBatches).toEqual([]);
    const insert = database.sqlRun.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO project_knowledge_draft_batches"),
    );
    expect(insert?.[1]).toMatchObject({
      draftId: "draft-child",
      status: "awaiting_input",
      promptHash,
      rawOutput: null,
    });
    expect(database.sqlAll).not.toHaveBeenCalled();
  });

  it("loads only persisted validated outputs for finalization", async () => {
    database.sqlGet.mockResolvedValue(draftRow());
    database.sqlAll.mockResolvedValue([
      { batch_index: 1, status: "validated", raw_output: "{}", validated_output: emptyKnowledge, system_prompt: "s", user_prompt: "u" },
      { batch_index: 2, status: "awaiting_input", raw_output: null, validated_output: null, system_prompt: "ss", user_prompt: "uu" },
    ]);

    const result = await loadProjectKnowledgeManualBatchResults({ scope, draftId: "draft-child" });
    expect(result).toMatchObject({
      batchCount: 2,
      validatedCount: 1,
      partialKnowledgeBases: [emptyKnowledge],
      rawOutputs: ["{}"],
    });
  });
});

describe("draft publication guards", () => {
  it("publishes the exact frozen draft as stale when source updates arrived afterward", async () => {
    const hashes = computeProjectKnowledgeHashes(emptyKnowledge);
    database.sqlGet.mockImplementation(async (sql: string) => {
      if (sql.includes("project_knowledge_drafts")) {
        return draftRow({
          generation_mode: "automatic",
          status: "ready_to_publish",
          blockers_json: [],
          proposed_knowledge_json: emptyKnowledge,
          semantic_hash: hashes.semanticKnowledgeHash,
          provenance_hash: hashes.provenanceHash,
          source_fingerprint: "frozen-fingerprint",
          pending_drift: true,
        });
      }
      if (sql.includes("project_knowledge_base")) {
        return {
          id: "knowledge-1",
          active_revision_id: "revision-1",
          validated_output: JSON.stringify(emptyKnowledge),
          semantic_hash: hashes.semanticKnowledgeHash,
          provenance_hash: hashes.provenanceHash,
        };
      }
      return undefined;
    });
    compiled.recordProjectKnowledgeRevision.mockResolvedValue({ revisionId: "revision-2", revisionNumber: 2 });

    await publishProjectKnowledgeDraft({
      scope,
      actor: "owner-1",
      draftId: "draft-child",
    });

    const publicationWrite = database.sqlRun.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO project_knowledge_base"));
    expect(publicationWrite?.[1]).toMatchObject({
      validatedOutput: JSON.stringify(emptyKnowledge),
      sourceFingerprint: "frozen-fingerprint",
      freshnessStatus: "stale",
    });
    expect(String((publicationWrite?.[1] as { staleReasonJson: string }).staleReasonJson))
      .toContain("Newer source updates will be included in the next build.");
    expect(database.sqlAll).not.toHaveBeenCalled();
    expect(database.sqlRun.mock.calls.some(([sql]) => String(sql).includes("SET status = 'rebase_required'"))).toBe(false);
    expect(compiled.recordProjectKnowledgeRevision).toHaveBeenCalledTimes(1);
    expect(migration.backfillProjectKnowledgeCompilerFoundation).not.toHaveBeenCalled();
  });

  it("marks a reviewed draft outdated when another admin published its base first", async () => {
    const hashes = computeProjectKnowledgeHashes(emptyKnowledge);
    database.sqlGet.mockImplementation(async (sql: string) => {
      if (sql.includes("project_knowledge_drafts")) {
        return draftRow({
          status: "ready_to_publish",
          blockers_json: [],
          proposed_knowledge_json: emptyKnowledge,
          semantic_hash: hashes.semanticKnowledgeHash,
          provenance_hash: hashes.provenanceHash,
          base_revision_id: "revision-1",
        });
      }
      if (sql.includes("project_knowledge_base")) {
        return {
          id: "knowledge-1",
          active_revision_id: "revision-2",
          validated_output: JSON.stringify(emptyKnowledge),
          semantic_hash: hashes.semanticKnowledgeHash,
          provenance_hash: hashes.provenanceHash,
        };
      }
      return undefined;
    });

    await publishProjectKnowledgeDraft({ scope, actor: "owner-2", draftId: "draft-child" });

    expect(database.sqlRun).toHaveBeenCalledWith(
      expect.stringContaining("status = 'superseded'"),
      expect.objectContaining({ draftId: "draft-child" }),
      expect.anything(),
    );
    expect(database.sqlRun.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO project_knowledge_base"))).toBe(false);
    expect(compiled.recordProjectKnowledgeRevision).not.toHaveBeenCalled();
  });

  it("rejects creation of rebase child drafts in v4", async () => {
    await expect(beginProjectKnowledgeDraft({
      scope,
      actor: "owner-1",
      generationMode: "manual",
      compilationMode: "full",
      parentDraftId: "draft-parent",
    })).rejects.toMatchObject({ code: AppErrorCode.KnowledgeDraftConflict });
    expect(database.withTransaction).not.toHaveBeenCalled();
  });
});

describe("draft lifecycle", () => {
  it("expires inactive manual drafts before beginning a new draft", async () => {
    database.sqlGet.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM project_knowledge_drafts")) {
        return draftRow({
          id: "generated-id",
          parent_draft_id: null,
          rebase_depth: 0,
          base_revision_id: null,
          source_manifest_json: [],
          source_fingerprint: computeProjectKnowledgeSourceFingerprint([]),
        });
      }
      return undefined;
    });

    await beginProjectKnowledgeDraft({
      scope,
      actor: "owner-1",
      generationMode: "manual",
      compilationMode: "full",
    });

    const expiryIndex = database.sqlRun.mock.calls.findIndex(([sql]) => String(sql).includes("manual_draft_expired"));
    const insertIndex = database.sqlRun.mock.calls.findIndex(([sql]) => String(sql).includes("INSERT INTO project_knowledge_drafts"));
    expect(expiryIndex).toBeGreaterThanOrEqual(0);
    expect(insertIndex).toBeGreaterThan(expiryIndex);
  });

  it("expires inactive manual drafts before listing drafts", async () => {
    database.sqlAll.mockResolvedValue([]);

    await expect(listProjectKnowledgeDrafts({ scope })).resolves.toEqual([]);

    expect(database.sqlRun).toHaveBeenCalledWith(
      expect.stringContaining("manual_draft_expired"),
      expect.objectContaining({ projectId: scope.projectId, azureProjectId: scope.azureProjectId }),
      undefined,
    );
  });

  it("expires inactive manual drafts in every nonterminal lifecycle state before direct reads", async () => {
    database.sqlGet.mockResolvedValue(draftRow({
      generation_mode: "manual",
      status: "superseded",
      status_reason: "manual_draft_expired",
    }));

    const result = await getProjectKnowledgeDraft({ scope, draftId: "draft-child" });

    expect(result).toMatchObject({ persistedStatus: "superseded", statusReason: "manual_draft_expired" });
    expect(database.sqlRun).toHaveBeenCalledWith(
      expect.stringContaining("status IN ('generating', 'awaiting_input', 'ready_for_review', 'blocked', 'rebase_required')"),
      expect.objectContaining({ projectId: scope.projectId, azureProjectId: scope.azureProjectId }),
      undefined,
    );
  });

  it("marks an open v2 draft for explicit regeneration under the v3 compiler contract", async () => {
    database.sqlGet.mockResolvedValue(draftRow({
      status: "blocked",
      compiler_contract_version: "2.0.0",
    }));

    const result = await getProjectKnowledgeDraft({ scope, draftId: "draft-child" });

    expect(result).toMatchObject({
      persistedStatus: "blocked",
      compilerContractVersion: "2.0.0",
      regenerateRequired: true,
    });
  });

  it("abandons a live draft under the project lock and records the prior state", async () => {
    database.sqlGet.mockResolvedValue(draftRow({ status: "blocked" }));

    const result = await abandonProjectKnowledgeDraft({ scope, draftId: "draft-child", actor: "owner-1" });

    expect(result).toMatchObject({ persistedStatus: "blocked" });
    expect(lock.acquireProjectKnowledgeLock).toHaveBeenCalledWith(scope, expect.anything());
    expect(database.sqlRun).toHaveBeenCalledWith(
      expect.stringContaining("status_reason = 'abandoned_by_user'"),
      expect.objectContaining({ draftId: "draft-child" }),
      expect.anything(),
    );
    expect(audit.writeAuditLogTransactional).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "rag.knowledge_draft.abandoned",
        actor: "owner-1",
        details: { previousStatus: "blocked" },
      }),
      expect.anything(),
    );
  });
});

describe("pipeline quality warnings", () => {
  const metricsRow = (metrics: Record<string, unknown>) => ({ metrics_json: metrics });
  const fidelityMetrics = (manualReanchorCount: number, quoteExactCount: number) => ({
    manualReanchorCount,
    quoteExactCount,
    quoteNormalizedCount: 0,
    quoteAutoReanchorCount: 0,
  });

  it("warns when the residual manual re-anchor rate exceeds 5% over a full window", async () => {
    database.sqlAll.mockResolvedValue(Array.from({ length: 20 }, () => metricsRow(fidelityMetrics(1, 9))));

    const warnings = await computeProjectKnowledgePipelineWarnings({ scope });

    expect(warnings).toEqual([expect.stringContaining("manual re-anchoring")]);
  });

  it("stays quiet below the threshold and on an incomplete window", async () => {
    database.sqlAll.mockResolvedValue(Array.from({ length: 20 }, () => metricsRow(fidelityMetrics(0, 10))));
    expect(await computeProjectKnowledgePipelineWarnings({ scope })).toEqual([]);

    // High rate, but only 19 drafts — early noise must not trip the alarm.
    database.sqlAll.mockResolvedValue(Array.from({ length: 19 }, () => metricsRow(fidelityMetrics(5, 5))));
    expect(await computeProjectKnowledgePipelineWarnings({ scope })).toEqual([]);
  });

  it("warns about unknown-model token fallback only with heavy splitting", async () => {
    database.sqlAll.mockResolvedValue([
      metricsRow({ inputTokenLimitSource: "unknown_fallback", splitCallCount: 6 }),
    ]);
    expect(await computeProjectKnowledgePipelineWarnings({ scope })).toEqual([
      expect.stringContaining("unrecognized model"),
    ]);

    database.sqlAll.mockResolvedValue([
      metricsRow({ inputTokenLimitSource: "unknown_fallback", splitCallCount: 2 }),
    ]);
    expect(await computeProjectKnowledgePipelineWarnings({ scope })).toEqual([]);
  });

  it("returns no warnings when no drafts exist", async () => {
    database.sqlAll.mockResolvedValue([]);
    expect(await computeProjectKnowledgePipelineWarnings({ scope })).toEqual([]);
  });
});
