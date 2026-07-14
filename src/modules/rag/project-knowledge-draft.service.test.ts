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
import { AppError, AppErrorCode } from "@/modules/shared/errors/app-error";
import {
  PROJECT_KNOWLEDGE_COMPILER_CONTRACT_VERSION,
  PROJECT_KNOWLEDGE_WORDING_VERSION,
  computeProjectKnowledgeSourceFingerprint,
  hashCanonicalValue,
} from "./project-knowledge-contracts";
import {
  beginProjectKnowledgeDraft,
  abandonProjectKnowledgeDraft,
  completeProjectKnowledgeDraft,
  computeProjectKnowledgePipelineWarnings,
  getProjectKnowledgeDraft,
  getProjectKnowledgeDraftReviewContext,
  listProjectKnowledgeDrafts,
  loadProjectKnowledgeManualBatchResults,
  publishProjectKnowledgeDraft,
  storeProjectKnowledgeManualDraftBatches,
  tryDeterministicProjectKnowledgeRebase,
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

  it("persists recovered evidence metrics and a ready status for unique matches", async () => {
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
    expect(update?.[1]).toMatchObject({ status: "ready_for_review", statusReason: null });
    expect(update?.[0]).toContain("review_ready_at = CASE");
    expect(update?.[1]).toMatchObject({ reviewReady: true, updatedAt: "2026-07-12T12:30:00.000Z" });
    const metrics = JSON.parse(String((update?.[1] as { metricsJson: string }).metricsJson));
    expect(metrics).toMatchObject({
      autoEvidenceRepairAttemptedCount: 1,
      autoEvidenceRepairCount: 1,
      autoEvidenceRepairUnresolvedCount: 0,
    });
    const persisted = JSON.parse(String((update?.[1] as { proposedKnowledgeJson: string }).proposedKnowledgeJson));
    expect(persisted.modules[0].evidenceRefs).toHaveLength(1);
  });

  it("persists a blocked status when automatic repair is ambiguous", async () => {
    prepareCompletion({
      title: "Customers complete checkout securely.",
      description: "Customers complete checkout securely.",
    });
    await completeProjectKnowledgeDraft({
      scope,
      draftId: "draft-child",
      provider: "openai",
      model: "model",
      rawOutput: JSON.stringify(proposal),
      knowledgeBase: proposal,
    });

    const update = database.sqlRun.mock.calls.find(([sql]) => String(sql).includes("SET status = @status"));
    expect(update?.[1]).toMatchObject({ status: "blocked", statusReason: "publication_blockers" });
    const blockers = JSON.parse(String((update?.[1] as { blockersJson: string }).blockersJson));
    expect(blockers).toEqual([expect.objectContaining({
      type: "missing_evidence_refs",
      category: "module",
      entryKey: "checkout",
      sourceWorkItemIds: ["42"],
    })]);
  });

  it("assigns repeated evidence issues to their matching references without id collisions", async () => {
    prepareCompletion({ description: "Actual immutable checkout content." });
    await completeProjectKnowledgeDraft({
      scope,
      draftId: "draft-child",
      provider: "openai",
      model: "model",
      rawOutput: "{}",
      recoverMissingEvidenceRefs: false,
      knowledgeBase: {
        ...emptyKnowledge,
        modules: [{
          ...proposal.modules[0],
          evidenceRefs: [
            {
              sourceSnapshotId: "snapshot-42",
              sourceWorkItemId: "42",
              sourceField: "description",
              quote: "Missing checkout statement one.",
              origin: "generated_v2",
              verification: "unverified",
            },
            {
              sourceSnapshotId: "snapshot-42",
              sourceWorkItemId: "42",
              sourceField: "description",
              quote: "Missing checkout statement two.",
              origin: "generated_v2",
              verification: "unverified",
            },
          ],
        }],
      },
    });

    const update = database.sqlRun.mock.calls.find(([sql]) => String(sql).includes("SET status = @status"));
    const blockers = JSON.parse(String((update?.[1] as { blockersJson: string }).blockersJson));
    expect(blockers).toHaveLength(2);
    expect(blockers.every((blocker: { type: string }) => blocker.type === "quote_mismatch")).toBe(true);
    expect(new Set(blockers.map((blocker: { id: string }) => blocker.id)).size).toBe(2);
    expect(new Set(blockers.map((blocker: { entryInstanceId: string }) => blocker.entryInstanceId)).size).toBe(1);
    expect(new Set(blockers.map((blocker: { referenceIdentity: string }) => blocker.referenceIdentity)).size).toBe(2);
  });

  it("consolidates only normalization-equivalent identities at the completion boundary", async () => {
    const row = draftRow({
      generation_mode: "automatic",
      status: "generating",
    });
    database.sqlGet.mockResolvedValue(row);
    database.sqlAll.mockResolvedValue([]);

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
          {
            id: "checkout_flow",
            name: "Checkout",
            description: "Handles checkout.",
            sourceWorkItemIds: ["10"],
            evidence: "Checkout is available.",
          },
          {
            id: "Checkout Flow",
            name: " checkout ",
            description: "handles   checkout.",
            sourceWorkItemIds: ["11"],
            evidence: "Customers use checkout.",
          },
          {
            id: "checkout-flow",
            name: "Checkout",
            description: "Handles returns instead.",
            sourceWorkItemIds: ["12"],
            evidence: "Returns use this flow.",
          },
          {
            id: "---",
            name: "Symbolic module",
            description: "A symbolic identifier.",
            sourceWorkItemIds: ["13"],
            evidence: "The symbolic module exists.",
          },
          {
            id: "___",
            name: "Symbolic module",
            description: "A symbolic identifier.",
            sourceWorkItemIds: ["14"],
            evidence: "Another symbolic module exists.",
          },
        ],
      },
    });

    const update = database.sqlRun.mock.calls.find(([sql]) => String(sql).includes("SET status = @status"));
    const persisted = JSON.parse(String((update?.[1] as { proposedKnowledgeJson: string }).proposedKnowledgeJson));
    const metrics = JSON.parse(String((update?.[1] as { metricsJson: string }).metricsJson));

    expect(persisted.modules).toHaveLength(4);
    expect(persisted.modules[0]).toMatchObject({
      id: "checkout_flow",
      sourceWorkItemIds: ["10", "11"],
      evidence: "Checkout is available. | Customers use checkout.",
    });
    expect(persisted.modules[1]).toMatchObject({
      id: "checkout-flow",
      description: "Handles returns instead.",
    });
    expect(persisted.modules.slice(2).map((entry: { id: string }) => entry.id)).toEqual(["---", "___"]);
    expect(metrics.automaticDuplicateConsolidationCount).toBe(5);
    expect(metrics.conflictCount).toBe(1);
  });

  it("suppresses evidence blockers for entries participating in an unresolved hard conflict", async () => {
    const row = draftRow({ generation_mode: "automatic", status: "generating" });
    database.sqlGet.mockResolvedValue(row);
    database.sqlAll.mockResolvedValue([]);

    await completeProjectKnowledgeDraft({
      scope,
      draftId: "draft-child",
      provider: "openai",
      model: "model",
      rawOutput: "{}",
      recoverMissingEvidenceRefs: false,
      knowledgeBase: {
        ...emptyKnowledge,
        glossary: [
          {
            term: "Payment Gateway",
            type: "system",
            definition: "Routes card payments.",
            sourceWorkItemIds: ["10"],
            evidence: "Routes card payments.",
          },
          {
            term: "Payment Gateway",
            type: "system",
            definition: "Routes bank transfers.",
            sourceWorkItemIds: ["11"],
            evidence: "Routes bank transfers.",
          },
        ],
      },
    });

    const update = database.sqlRun.mock.calls.find(([sql]) => String(sql).includes("SET status = @status"));
    const blockers = JSON.parse(String((update?.[1] as { blockersJson: string }).blockersJson));
    expect(blockers).toEqual([expect.objectContaining({
      type: "hard_conflict",
      affectedCategory: "glossary",
      entryInstanceId: expect.stringMatching(/^pkei_/),
      participants: expect.arrayContaining([
        expect.objectContaining({ sourceWorkItemIds: ["10"] }),
        expect.objectContaining({ sourceWorkItemIds: ["11"] }),
      ]),
    })]);
    expect(blockers.some((blocker: { type: string }) => blocker.type === "missing_evidence_refs")).toBe(false);
  });

  it.each([
    {
      label: "available source fields",
      manifestEntries: manifest,
      snapshots: [{
        id: "snapshot-42",
        azure_work_item_id: "42",
        fields_json: { description: "Customers complete checkout securely." },
      }],
      expected: "available",
    },
    {
      label: "a missing snapshot",
      manifestEntries: manifest,
      snapshots: [],
      expected: "snapshot_missing",
    },
    {
      label: "an unmatched work item",
      manifestEntries: [],
      snapshots: [],
      expected: "unmatched_work_item",
    },
    {
      label: "a snapshot with no reviewable fields",
      manifestEntries: manifest,
      snapshots: [{ id: "snapshot-42", azure_work_item_id: "42", fields_json: {} }],
      expected: "empty_fields",
    },
  ])("reports review source availability for $label", async ({ manifestEntries, snapshots, expected }) => {
    database.sqlGet.mockResolvedValue(draftRow({
      status: "blocked",
      source_manifest_json: manifestEntries,
      proposed_knowledge_json: proposal,
      blockers_json: [{
        type: "missing_evidence_refs",
        category: "module",
        entryKey: "checkout",
        sourceWorkItemIds: ["42"],
      }],
    }));
    database.sqlAll.mockResolvedValue(snapshots);

    const context = await getProjectKnowledgeDraftReviewContext({ scope, draftId: "draft-child" });

    expect(context?.entries).toEqual([expect.objectContaining({
      category: "module",
      entryKey: "checkout",
      entryInstanceId: expect.stringMatching(/^pkei_/),
      sourceAvailability: expected,
      affectedWorkItemIds: ["42"],
    })]);
    if (expected === "available") {
      expect(context?.entries[0].sources[0]).toMatchObject({
        sourceSnapshotId: "snapshot-42",
        sourceWorkItemId: "42",
        fields: [{ sourceField: "description", text: "Customers complete checkout securely." }],
      });
    }
  });

  it("suggests a unique re-anchor from the manifest pool when the cited snapshot is gone", async () => {
    const reviewManifest = [
      ...manifest,
      {
        sourceSnapshotId: "snapshot-99",
        sourceWorkItemId: "99",
        workItemType: "User Story",
        contentHash: "hash-99",
        adoRevision: 2,
        sourceUpdatedAt: "2026-07-12T12:00:00.000Z",
        capturedAt: "2026-07-12T12:00:00.000Z",
      },
    ];
    database.sqlGet.mockResolvedValue(draftRow({
      status: "blocked",
      source_manifest_json: reviewManifest,
      proposed_knowledge_json: proposal,
      blockers_json: [{
        type: "missing_evidence_refs",
        category: "module",
        entryKey: "checkout",
        sourceWorkItemIds: ["42"],
      }],
    }));
    database.sqlAll.mockImplementation(async (_sql: string, params: { snapshotIds?: string[] }) => {
      // Suggestion search widens the load to the whole frozen manifest pool.
      expect(params.snapshotIds).toEqual(expect.arrayContaining(["snapshot-42", "snapshot-99"]));
      return [{
        id: "snapshot-99",
        azure_work_item_id: "99",
        fields_json: { description: "Customers complete checkout securely." },
      }];
    });

    const context = await getProjectKnowledgeDraftReviewContext({ scope, draftId: "draft-child" });

    expect(context?.entries[0]).toMatchObject({
      category: "module",
      entryKey: "checkout",
      sourceAvailability: "snapshot_missing",
      suggestedEvidence: [{
        sourceSnapshotId: "snapshot-99",
        sourceWorkItemId: "99",
        sourceField: "description",
        quote: "Customers complete checkout securely.",
        verification: "exact",
      }],
    });
  });

  it("offers no suggestion when the evidence text is ambiguous across the pool", async () => {
    database.sqlGet.mockResolvedValue(draftRow({
      status: "blocked",
      source_manifest_json: manifest,
      proposed_knowledge_json: proposal,
      blockers_json: [{
        type: "missing_evidence_refs",
        category: "module",
        entryKey: "checkout",
        sourceWorkItemIds: ["42"],
      }],
    }));
    database.sqlAll.mockResolvedValue([{
      id: "snapshot-42",
      azure_work_item_id: "42",
      fields_json: {
        title: "Customers complete checkout securely.",
        description: "Customers complete checkout securely.",
      },
    }]);

    const context = await getProjectKnowledgeDraftReviewContext({ scope, draftId: "draft-child" });

    expect(context?.entries[0].sourceAvailability).toBe("available");
    expect(context?.entries[0].suggestedEvidence).toBeUndefined();
  });

  it("loads friendly source metadata for hard-conflict comparison without exposing storage details", async () => {
    const reviewManifest = [
      ...manifest,
      {
        sourceSnapshotId: "snapshot-99",
        sourceWorkItemId: "99",
        workItemType: "Bug",
        contentHash: "hash-99",
        adoRevision: 3,
        sourceUpdatedAt: "2026-07-12T12:00:00.000Z",
        capturedAt: "2026-07-12T12:00:00.000Z",
      },
    ];
    database.sqlGet.mockResolvedValue(draftRow({
      status: "blocked",
      source_manifest_json: reviewManifest,
      proposed_knowledge_json: proposal,
      blockers_json: [{
        type: "hard_conflict",
        identityKey: "conflict-1",
        affectedCategory: "module",
        participants: [{
          sourceSnapshotIds: ["snapshot-42"],
          sourceWorkItemIds: ["42"],
          evidenceRefs: [],
        }],
      }],
    }));
    database.sqlAll.mockImplementation(async (_sql: string, params: { snapshotIds?: string[] }) => {
      expect(params.snapshotIds).toEqual(["snapshot-42"]);
      return [
        {
          id: "snapshot-42",
          azure_work_item_id: "42",
          fields_json: {
            title: "Secure checkout",
            description: "Customers complete checkout securely.",
          },
        },
        {
          id: "snapshot-99",
          azure_work_item_id: "99",
          fields_json: {
            title: "Unrelated work item",
            description: "This snapshot must not be loaded for the conflict.",
          },
        },
      ].filter((snapshot) => params.snapshotIds?.includes(snapshot.id));
    });

    const context = await getProjectKnowledgeDraftReviewContext({ scope, draftId: "draft-child" });

    expect(context).toEqual({
      entries: [],
      sources: [{
        sourceSnapshotId: "snapshot-42",
        sourceWorkItemId: "42",
        workItemType: "User Story",
        workItemTitle: "Secure checkout",
        workItemUrl: "https://dev.azure.com/demo/Demo%20Project/_workitems/edit/42",
        adoRevision: 1,
        sourceUpdatedAt: "2026-07-12T12:00:00.000Z",
        capturedAt: "2026-07-12T12:00:00.000Z",
        fields: [
          { sourceField: "title", text: "Secure checkout" },
          { sourceField: "description", text: "Customers complete checkout securely." },
        ],
      }],
    });
    expect(context?.sources.some((source) => source.sourceSnapshotId === "snapshot-99")).toBe(false);
  });
});

describe("manual draft batch persistence", () => {
  it("carries an answer only when prompt hash and compiler contract both match", async () => {
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

    expect(result.carriedBatches).toEqual([{
      batchIndex: 1,
      rawOutput: "{}",
      validatedOutput: emptyKnowledge,
    }]);
    const insert = database.sqlRun.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO project_knowledge_draft_batches"),
    );
    expect(insert?.[1]).toMatchObject({
      draftId: "draft-child",
      status: "validated",
      promptHash,
      rawOutput: "{}",
    });
    expect(database.sqlRun.mock.calls.some(([sql, params]) =>
      String(sql).includes("DELETE FROM project_knowledge_draft_batches") &&
      (params as { draftId?: string }).draftId === "draft-parent",
    )).toBe(false);
  });

  it("does not carry an answer from an incompatible compiler contract", async () => {
    database.sqlGet.mockResolvedValue(draftRow());
    database.sqlAll.mockResolvedValue([{
      prompt_hash: hashCanonicalValue({ system: "system", user: "user" }),
      compiler_contract_version: "2.0.0",
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
    expect(insert?.[1]).toMatchObject({ status: "awaiting_input", rawOutput: null });
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
  it("persists rebase_required before rejecting a stale preview save", async () => {
    const manifest = [{
      source_snapshot_id: "snapshot-new",
      source_work_item_id: "42",
      work_item_type: "User Story",
      content_hash: "new-hash",
      ado_revision: 2,
      source_updated_at: "2026-07-12T12:00:00.000Z",
      captured_at: "2026-07-12T12:00:00.000Z",
    }];
    database.sqlGet.mockImplementation(async (sql: string) => {
      if (sql.includes("project_knowledge_drafts")) {
        return draftRow({
          generation_mode: "automatic",
          status: "ready_for_review",
          blockers_json: [],
          proposed_knowledge_json: emptyKnowledge,
          semantic_hash: "semantic",
          provenance_hash: "provenance",
          source_fingerprint: "stale-fingerprint",
        });
      }
      if (sql.includes("project_knowledge_base")) {
        return {
          id: "knowledge-1",
          active_revision_id: "revision-1",
          validated_output: JSON.stringify(emptyKnowledge),
          semantic_hash: "semantic",
          provenance_hash: "provenance",
        };
      }
      return undefined;
    });
    database.sqlAll.mockResolvedValue(manifest);

    await expect(publishProjectKnowledgeDraft({
      scope,
      actor: "owner-1",
      draftId: "draft-child",
    })).rejects.toMatchObject({ code: AppErrorCode.KnowledgeDraftConflict });

    expect(database.sqlRun).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'rebase_required'"),
      expect.objectContaining({ draftId: "draft-child", reason: "source_drift" }),
      expect.anything(),
    );
    expect(compiled.recordProjectKnowledgeRevision).not.toHaveBeenCalled();
    expect(lock.acquireProjectKnowledgeLock.mock.invocationCallOrder[0]).toBeLessThan(
      migration.backfillProjectKnowledgeCompilerFoundation.mock.invocationCallOrder[0],
    );
  });

  it("maps the one-live-child unique index to a stable draft conflict", async () => {
    database.withTransaction.mockRejectedValue(Object.assign(new Error("duplicate child"), {
      code: "23505",
      constraint: "idx_knowledge_drafts_one_live_child",
    }));

    let error: unknown;
    try {
      await beginProjectKnowledgeDraft({
        scope,
        actor: "owner-1",
        generationMode: "manual",
        compilationMode: "full",
        parentDraftId: "draft-parent",
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: AppErrorCode.KnowledgeDraftConflict });
  });

  it("requires a fresh full preview after the third rebase depth", async () => {
    database.sqlGet.mockResolvedValue(draftRow({
      generation_mode: "automatic",
      status: "rebase_required",
      rebase_depth: 3,
    }));

    await expect(tryDeterministicProjectKnowledgeRebase({
      scope,
      actor: "owner-1",
      parentDraftId: "draft-parent",
    })).resolves.toEqual({ kind: "full_preview_required", reason: "depth_limit" });
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
