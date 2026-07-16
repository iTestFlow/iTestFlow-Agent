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
  buildProjectKnowledgeCitationSources,
  groundGeneratedProjectKnowledge,
  projectKnowledgeCitationHandle,
  type ProjectKnowledgeGeneratedBase,
} from "./project-knowledge-grounding";
import { ProjectKnowledgeBaseSchema, type ProjectKnowledgeBase } from "./project-knowledge.schema";
import {
  applyProjectKnowledgeConflictDecisions,
  beginProjectKnowledgeDraft,
  abandonProjectKnowledgeDraft,
  completeProjectKnowledgeDraft,
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

  type FrozenFixtureSource = {
    id: string;
    workItemId: string;
    acceptanceCriteria: string;
  };

  function frozenFixtureCitation(snapshotId: string, quote: string) {
    return {
      handle: projectKnowledgeCitationHandle(snapshotId, "acceptanceCriteria"),
      quote,
    };
  }

  function prepareCompletionForFrozenFixture(snapshots: FrozenFixtureSource[]) {
    const fixtureManifest = snapshots.map((snapshot, index) => ({
      sourceSnapshotId: snapshot.id,
      sourceWorkItemId: snapshot.workItemId,
      workItemType: "User Story",
      contentHash: `frozen-${index + 1}`,
      adoRevision: 1,
      sourceUpdatedAt: "2026-07-12T12:00:00.000Z",
      capturedAt: "2026-07-12T12:00:00.000Z",
    }));
    const row = draftRow({
      generation_mode: "automatic",
      status: "generating",
      source_manifest_json: fixtureManifest,
      source_fingerprint: computeProjectKnowledgeSourceFingerprint(fixtureManifest),
    });
    database.sqlGet.mockImplementation(async (sql: string) =>
      sql.includes("project_knowledge_drafts") ? row : undefined);
    database.sqlAll.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT id, azure_work_item_id, fields_json")) {
        return snapshots.map((snapshot) => ({
          id: snapshot.id,
          azure_work_item_id: snapshot.workItemId,
          fields_json: { acceptanceCriteria: snapshot.acceptanceCriteria },
        }));
      }
      if (sql.includes("JOIN azure_devops_work_item_snapshots")) {
        return fixtureManifest.map((snapshot) => ({
          source_snapshot_id: snapshot.sourceSnapshotId,
          source_work_item_id: snapshot.sourceWorkItemId,
          work_item_type: snapshot.workItemType,
          content_hash: snapshot.contentHash,
          ado_revision: snapshot.adoRevision,
          source_updated_at: snapshot.sourceUpdatedAt,
          captured_at: snapshot.capturedAt,
        }));
      }
      return [];
    });
  }

  async function completeGroundedFrozenFixture(input: {
    snapshots: FrozenFixtureSource[];
    generated: ProjectKnowledgeGeneratedBase;
  }) {
    const grounding = groundGeneratedProjectKnowledge({
      generated: input.generated,
      sources: buildProjectKnowledgeCitationSources(input.snapshots.map((snapshot) => ({
        id: snapshot.workItemId,
        sourceSnapshotId: snapshot.id,
        workItemType: "User Story",
        title: `Frozen v4.1 fixture ${snapshot.workItemId}`,
        acceptanceCriteria: snapshot.acceptanceCriteria,
      }))),
    });
    prepareCompletionForFrozenFixture(input.snapshots);

    await completeProjectKnowledgeDraft({
      scope,
      draftId: "draft-child",
      provider: "openai",
      model: "model",
      rawOutput: JSON.stringify(input.generated),
      knowledgeBase: grounding.knowledgeBase,
    });

    const update = database.sqlRun.mock.calls.find(([sql]) => String(sql).includes("SET status = @status"));
    if (!update) throw new Error("Expected the grounded draft completion update.");
    const params = update[1] as {
      blockersJson: string;
      metricsJson: string;
      proposedKnowledgeJson: string;
      status: string;
      statusReason: string | null;
    };
    const blockers = JSON.parse(params.blockersJson) as unknown[];
    const metrics = JSON.parse(params.metricsJson) as Record<string, unknown>;
    const persisted = JSON.parse(params.proposedKnowledgeJson) as ProjectKnowledgeBase;

    expect(grounding.omissions).toEqual([]);
    expect(params).toMatchObject({ status: "ready_to_publish", statusReason: null });
    expect(blockers).toEqual([]);
    expect(metrics.conflictCount).toBe(0);
    return { grounding, metrics, persisted };
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

  it("merges duplicate glossary identities before detecting grounded semantic conflicts", async () => {
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
    expect(update?.[1]).toMatchObject({ status: "ready_to_publish", statusReason: null });
    const persisted = JSON.parse(String((update?.[1] as { proposedKnowledgeJson: string }).proposedKnowledgeJson));
    const blockers = JSON.parse(String((update?.[1] as { blockersJson: string }).blockersJson));
    const metrics = JSON.parse(String((update?.[1] as { metricsJson: string }).metricsJson));

    expect(persisted.glossary).toEqual([expect.objectContaining({
      term: "Payment Gateway",
      type: "system",
      definition: "Routes bank transfers.",
      sourceWorkItemIds: ["42"],
      evidenceRefs: expect.arrayContaining([
        expect.objectContaining({ quote: "Routes card payments." }),
        expect.objectContaining({ quote: "Routes bank transfers." }),
      ]),
    })]);
    expect(persisted.glossary[0].evidenceRefs).toHaveLength(2);
    expect(blockers).toEqual([]);
    expect(metrics).toMatchObject({
      preConsolidationDuplicateIdentityCount: 1,
      paraphraseMergeCount: 1,
      rekeyCount: 0,
      possibleTensionCount: 0,
      conflictCount: 0,
    });
  });

  it("grounds and merges the frozen Quote Timeout Popup variants without collapsing its trigger", async () => {
    const nonDismissible = "The quote timeout popup must be non-dismissible, with no close X and no overlay click-through; the user must select one of the available actions.";
    const equivalentNonDismissible = "The quote timeout popup is non-dismissible; it has no close X and no overlay click-through, and the user must select one of the available actions.";
    const trigger = "The quote timeout popup must be triggered exclusively by the front-end timer reaching zero on Step 4 or Step 5, and not by backend errors.";
    const result = await completeGroundedFrozenFixture({
      snapshots: [
        { id: "snapshot-366149-a", workItemId: "366149-a", acceptanceCriteria: nonDismissible },
        { id: "snapshot-366149-b", workItemId: "366149-b", acceptanceCriteria: equivalentNonDismissible },
        { id: "snapshot-366149-c", workItemId: "366149-c", acceptanceCriteria: trigger },
      ],
      generated: {
        modules: [],
        businessRules: [
          {
            id: "br-quote-timeout-popup-non-dismissible",
            rule: nonDismissible,
            moduleName: "Quote Expiry Management",
            constraint: {
              object: "quote timeout popup", property: "dismissible", operator: "eq", value: "non-dismissible", valueType: "enum",
            },
            citations: [frozenFixtureCitation("snapshot-366149-a", nonDismissible)],
          },
          {
            id: "br-quote-timeout-popup-non-dismissible",
            rule: equivalentNonDismissible,
            moduleName: "Quote Expiry Management",
            constraint: {
              object: "quote timeout popup", property: "dismissible", operator: "eq", value: "non-dismissible", valueType: "enum",
            },
            citations: [frozenFixtureCitation("snapshot-366149-b", equivalentNonDismissible)],
          },
          {
            id: "br-timeout-trigger-frontend-only",
            rule: trigger,
            moduleName: "Quote Expiry Management",
            citations: [frozenFixtureCitation("snapshot-366149-c", trigger)],
          },
        ],
        stateTransitions: [],
        glossary: [],
        crossDependencies: [],
      },
    });

    expect(result.grounding.constraintRejectionCount).toBe(0);
    expect(result.persisted.businessRules).toHaveLength(2);
    expect(result.persisted.businessRules).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "br-quote-timeout-popup-non-dismissible",
        evidenceRefs: expect.arrayContaining([
          expect.objectContaining({ sourceWorkItemId: "366149-a" }),
          expect.objectContaining({ sourceWorkItemId: "366149-b" }),
        ]),
      }),
      expect.objectContaining({ id: "br-timeout-trigger-frontend-only" }),
    ]));
    expect(result.metrics).toMatchObject({
      paraphraseMergeCount: 1,
      rekeyCount: 0,
      possibleTensionCount: 0,
    });
  });

  it("grounds and merges the frozen Masked Card Number variants with module associations", async () => {
    const paymentRetrials = "Card numbers must be displayed with all but the last 4 digits masked, for example **** **** **** 1234.";
    const policyDetails = "Card numbers are displayed with all but the last 4 digits masked, for example **** **** **** 1234.";
    const result = await completeGroundedFrozenFixture({
      snapshots: [
        { id: "snapshot-367569", workItemId: "367569", acceptanceCriteria: paymentRetrials },
        { id: "snapshot-360500", workItemId: "360500", acceptanceCriteria: policyDetails },
      ],
      generated: {
        modules: [],
        businessRules: [
          {
            id: "br-masked-card-number",
            rule: paymentRetrials,
            moduleName: "Payment Retrials Tab",
            constraint: {
              object: "card number", property: "masking", operator: "eq", value: "masked", valueType: "enum",
            },
            citations: [frozenFixtureCitation("snapshot-367569", paymentRetrials)],
          },
          {
            id: "br-masked-card-number",
            rule: policyDetails,
            moduleName: "Policy Details",
            constraint: {
              object: "card number", property: "masking", operator: "eq", value: "masked", valueType: "enum",
            },
            citations: [frozenFixtureCitation("snapshot-360500", policyDetails)],
          },
        ],
        stateTransitions: [],
        glossary: [],
        crossDependencies: [],
      },
    });

    expect(result.grounding.constraintRejectionCount).toBe(0);
    expect(result.persisted.businessRules).toEqual([
      expect.objectContaining({
        id: "br-masked-card-number",
        moduleName: "Payment Retrials Tab",
        moduleAssociations: ["Payment Retrials Tab", "Policy Details"],
        sourceWorkItemIds: ["360500", "367569"],
        evidenceRefs: expect.arrayContaining([
          expect.objectContaining({ quote: paymentRetrials }),
          expect.objectContaining({ quote: policyDetails }),
        ]),
      }),
    ]);
    expect(result.metrics).toMatchObject({
      paraphraseMergeCount: 1,
      rekeyCount: 0,
      possibleTensionCount: 0,
    });
  });

  it("grounds the frozen Purchase Notification variants, re-keys them, and keeps their tension non-blocking", async () => {
    const issuedDocument = "Download Policy is enabled only when the policy document has been issued and the document URL is available; if policy status is Pending, it is disabled with a tooltip explaining that the document is not yet available.";
    const notificationResponse = "Download Policy is enabled only when the policy document URL has been received and stored from the insurance company's purchase notification response; otherwise it is disabled with a tooltip.";
    const result = await completeGroundedFrozenFixture({
      snapshots: [
        { id: "snapshot-360014-a", workItemId: "360014-a", acceptanceCriteria: issuedDocument },
        { id: "snapshot-360014-b", workItemId: "360014-b", acceptanceCriteria: notificationResponse },
      ],
      generated: {
        modules: [],
        businessRules: [
          {
            id: "br-download-policy-availability",
            rule: issuedDocument,
            moduleName: "Policy Document Downloads",
            citations: [frozenFixtureCitation("snapshot-360014-a", issuedDocument)],
          },
          {
            id: "br-download-policy-availability",
            rule: notificationResponse,
            moduleName: "Policy Document Downloads",
            citations: [frozenFixtureCitation("snapshot-360014-b", notificationResponse)],
          },
        ],
        stateTransitions: [],
        glossary: [],
        crossDependencies: [],
      },
    });

    const ids = result.persisted.businessRules.map((entry) => entry.id);
    expect(ids).toContain("br-download-policy-availability");
    expect(ids.some((id) => id.startsWith("br-download-policy-availability-"))).toBe(true);
    expect(result.persisted.businessRules).toHaveLength(2);
    expect(result.metrics).toMatchObject({
      rekeyCount: 1,
      possibleTensionCount: 1,
      possibleTensions: [expect.objectContaining({
        category: "business_rule",
        reason: "fingerprint_mismatch",
      })],
    });
  });

  it("grounds the frozen Download Loading variants, re-keys them, and keeps their tension non-blocking", async () => {
    const skeleton = "While quotes are being fetched from the aggregator, a loading skeleton or spinner is displayed in place of the quote list; the sort dropdown and expiry timer are hidden until at least one quote is received.";
    const loading = "While quotes are being fetched from the aggregator, display a loading skeleton/spinner in place of the quote list, and hide the sort dropdown and expiry timer until at least one quote is received.";
    const result = await completeGroundedFrozenFixture({
      snapshots: [
        { id: "snapshot-358867-a", workItemId: "358867-a", acceptanceCriteria: skeleton },
        { id: "snapshot-358867-b", workItemId: "358867-b", acceptanceCriteria: loading },
      ],
      generated: {
        modules: [],
        businessRules: [
          {
            id: "br-loading-quotes-state",
            rule: skeleton,
            moduleName: "Quote List",
            citations: [frozenFixtureCitation("snapshot-358867-a", skeleton)],
          },
          {
            id: "br-loading-quotes-state",
            rule: loading,
            moduleName: "Quote List",
            citations: [frozenFixtureCitation("snapshot-358867-b", loading)],
          },
        ],
        stateTransitions: [],
        glossary: [],
        crossDependencies: [],
      },
    });

    const ids = result.persisted.businessRules.map((entry) => entry.id);
    expect(ids).toContain("br-loading-quotes-state");
    expect(ids.some((id) => id.startsWith("br-loading-quotes-state-"))).toBe(true);
    expect(result.persisted.businessRules).toHaveLength(2);
    expect(result.metrics).toMatchObject({
      rekeyCount: 1,
      possibleTensionCount: 1,
      possibleTensions: [expect.objectContaining({
        category: "business_rule",
        reason: "fingerprint_mismatch",
      })],
    });
  });

  it("grounds the frozen Political Declaration dependency variants and re-keys their non-hierarchical types", async () => {
    const quote = "Political Declaration answers are not sent to the unified payment service.";
    const result = await completeGroundedFrozenFixture({
      snapshots: [{
        id: "snapshot-political-declaration-payment-service",
        workItemId: "political-declaration-payment-service",
        acceptanceCriteria: quote,
      }],
      generated: {
        modules: [],
        businessRules: [],
        stateTransitions: [],
        glossary: [],
        crossDependencies: [
          {
            id: "dep-political-declaration-unified-payment-service",
            sourceModule: "Political Declaration",
            targetModule: "Unified payment service",
            dependencyType: "data_exclusion",
            description: "Political Declaration answers are saved against the application record and are not sent to the unified payment service.",
            citations: [frozenFixtureCitation("snapshot-political-declaration-payment-service", quote)],
          },
          {
            id: "dep-political-declaration-unified-payment-service",
            sourceModule: "Political Declaration",
            targetModule: "Unified payment service",
            dependencyType: "exclusion",
            description: quote,
            citations: [frozenFixtureCitation("snapshot-political-declaration-payment-service", quote)],
          },
        ],
      },
    });

    const ids = result.persisted.crossDependencies.map((entry) => entry.id);
    expect(ids).toContain("dep-political-declaration-unified-payment-service");
    expect(ids.some((id) => id.startsWith("dep-political-declaration-unified-payment-service-"))).toBe(true);
    expect(result.persisted.crossDependencies).toHaveLength(2);
    expect(result.metrics).toMatchObject({
      rekeyCount: 1,
      possibleTensionCount: 0,
    });
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
  function prepareBusinessRuleCombination(input: { ruleWinnerKeepsMetadata: boolean }) {
    const firstQuote = "Retry count must be 3.";
    const secondQuote = "Retry count must be 5.";
    const sourceSnapshotId = "snapshot-decision";
    const sourceWorkItemId = "decision";
    const first = {
      id: "br-retry-first",
      rule: firstQuote,
      sourceField: "acceptanceCriteria",
      moduleName: "Payments",
      ...(input.ruleWinnerKeepsMetadata ? {} : {
        moduleAssociations: ["Orders"],
        constraint: {
          object: "retry",
          property: "count",
          operator: "eq" as const,
          value: "3",
          valueType: "number" as const,
        },
      }),
      sourceWorkItemIds: [sourceWorkItemId],
      evidence: firstQuote,
      evidenceRefs: [{
        sourceSnapshotId,
        sourceWorkItemId,
        sourceField: "acceptanceCriteria" as const,
        quote: firstQuote,
        origin: "generated_v4" as const,
        verification: "exact" as const,
      }],
    };
    const second = {
      id: "br-retry-second",
      rule: secondQuote,
      sourceField: "acceptanceCriteria",
      moduleName: "Payments",
      ...(input.ruleWinnerKeepsMetadata ? {
        moduleAssociations: ["Orders", "Payments"],
        constraint: {
          object: "retry",
          property: "count",
          operator: "eq" as const,
          value: "5",
          valueType: "number" as const,
        },
      } : {}),
      sourceWorkItemIds: [sourceWorkItemId],
      evidence: secondQuote,
      evidenceRefs: [{
        sourceSnapshotId,
        sourceWorkItemId,
        sourceField: "acceptanceCriteria" as const,
        quote: secondQuote,
        origin: "generated_v4" as const,
        verification: "exact" as const,
      }],
    };
    const knowledge = ProjectKnowledgeBaseSchema.parse({ businessRules: [first, second] });
    const [firstEntry, secondEntry] = knowledge.businessRules;
    if (!firstEntry || !secondEntry) throw new Error("Expected two business-rule participants.");
    const hashes = computeProjectKnowledgeHashes(knowledge);
    const participants = [firstEntry, secondEntry].map((entry, index) => ({
      participantId: `participant-${index + 1}`,
      category: "business_rule" as const,
      entryKey: entry.id,
      entry,
      projection: { rule: entry.rule, sourceField: entry.sourceField, moduleName: entry.moduleName ?? null },
      semanticHash: `semantic-${index + 1}`,
      concreteValue: index === 0 ? "3" : "5",
      evidenceRefs: entry.evidenceRefs,
      sourceSnapshotIds: [sourceSnapshotId],
      sourceWorkItemIds: [sourceWorkItemId],
      evidence: entry.evidence,
    }));
    const blocker = {
      id: "conflict-retry",
      type: "hard_conflict",
      category: "hard_conflict",
      entryKey: "retry-count",
      entryInstanceId: "retry-count-instance",
      identityKey: "retry-count-conflict",
      subject: "payments:retry.count",
      conflictType: "incompatible_concrete_value",
      affectedCategory: "business_rule",
      participants,
      evidenceIdentical: false,
      message: "Choose a supported version.",
    };
    const retainedTension = {
      category: "business_rule",
      subject: "identity:business_rule:retry-count",
      entryKeys: [firstEntry.id, secondEntry.id],
      reason: "fingerprint_mismatch",
    };
    const row = draftRow({
      generation_mode: "automatic",
      status: "blocked",
      source_manifest_json: [{
        sourceSnapshotId,
        sourceWorkItemId,
        workItemType: "User Story",
        contentHash: "decision-hash",
        adoRevision: 1,
        sourceUpdatedAt: "2026-07-12T12:00:00.000Z",
        capturedAt: "2026-07-12T12:00:00.000Z",
      }],
      proposed_knowledge_json: knowledge,
      blockers_json: [blocker],
      metrics_json: {
        preConsolidationDuplicateIdentityCount: 2,
        paraphraseMergeCount: 3,
        rekeyCount: 4,
        atomicExtractionFailureCount: 5,
        possibleTensionCount: 1,
        possibleTensions: [retainedTension],
      },
      semantic_hash: hashes.semanticKnowledgeHash,
      provenance_hash: hashes.provenanceHash,
    });
    database.sqlGet.mockResolvedValue(row);
    database.sqlAll.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT id, azure_work_item_id, fields_json")) {
        return [{
          id: sourceSnapshotId,
          azure_work_item_id: sourceWorkItemId,
          fields_json: { acceptanceCriteria: `${firstQuote} ${secondQuote}` },
        }];
      }
      return [];
    });
    return {
      draftVersion: `pkdv_${hashCanonicalValue({
        draftId: row.id,
        semanticHash: hashes.semanticKnowledgeHash,
        provenanceHash: hashes.provenanceHash,
        conflicts: [blocker.identityKey],
      }).slice(0, 32)}`,
      decision: {
        conflictId: blocker.id,
        action: "combine" as const,
        fieldParticipants: {
          rule: "participant-2",
          sourceField: "participant-2",
          moduleName: "participant-2",
        },
      },
      retainedTension,
    };
  }

  async function applyBusinessRuleCombination(input: { ruleWinnerKeepsMetadata: boolean }) {
    const prepared = prepareBusinessRuleCombination(input);
    await applyProjectKnowledgeConflictDecisions({
      scope,
      actor: "owner-1",
      draftId: "draft-child",
      draftVersion: prepared.draftVersion,
      decisions: [prepared.decision],
    });
    const update = database.sqlRun.mock.calls.find(([sql]) => String(sql).includes("SET status = @status"));
    if (!update) throw new Error("Expected the decision-completion update.");
    return {
      persisted: JSON.parse(String((update[1] as { proposedKnowledgeJson: string }).proposedKnowledgeJson)),
      metrics: JSON.parse(String((update[1] as { metricsJson: string }).metricsJson)),
      retainedTension: prepared.retainedTension,
    };
  }

  it("uses the rule winner's absent metadata instead of retaining a stale atomic constraint", async () => {
    const result = await applyBusinessRuleCombination({ ruleWinnerKeepsMetadata: false });

    expect(result.persisted.businessRules).toEqual([
      expect.objectContaining({ id: "br-retry-first", rule: "Retry count must be 5." }),
    ]);
    expect(result.persisted.businessRules[0]).not.toHaveProperty("constraint");
    expect(result.persisted.businessRules[0]).not.toHaveProperty("moduleAssociations");
    expect(result.metrics).toMatchObject({
      preConsolidationDuplicateIdentityCount: 2,
      paraphraseMergeCount: 3,
      rekeyCount: 4,
      atomicExtractionFailureCount: 5,
      possibleTensionCount: 1,
      possibleTensions: [result.retainedTension],
    });
  });

  it("preserves decision metrics and tensions through a second blocked decision lifecycle", async () => {
    const firstPass = await applyBusinessRuleCombination({ ruleWinnerKeepsMetadata: false });
    const approvedQuote = "Manager review moves the order to Approved.";
    const rejectedQuote = "Manager review moves the order to Rejected.";
    const reentrySnapshotId = "snapshot-reentry";
    const reentryWorkItemId = "reentry";
    const reentryKnowledge = ProjectKnowledgeBaseSchema.parse({
      ...firstPass.persisted,
      stateTransitions: [
        {
          id: "st-order-approved",
          workflowName: "Order",
          fromState: "Pending",
          toState: "Approved",
          triggerOrCondition: "Manager review",
          sourceWorkItemIds: [reentryWorkItemId],
          evidence: approvedQuote,
          evidenceRefs: [{
            sourceSnapshotId: reentrySnapshotId,
            sourceWorkItemId: reentryWorkItemId,
            sourceField: "acceptanceCriteria" as const,
            quote: approvedQuote,
            origin: "generated_v4" as const,
            verification: "exact" as const,
          }],
        },
        {
          id: "st-order-rejected",
          workflowName: "Order",
          fromState: "Pending",
          toState: "Rejected",
          triggerOrCondition: "Manager review",
          sourceWorkItemIds: [reentryWorkItemId],
          evidence: rejectedQuote,
          evidenceRefs: [{
            sourceSnapshotId: reentrySnapshotId,
            sourceWorkItemId: reentryWorkItemId,
            sourceField: "acceptanceCriteria" as const,
            quote: rejectedQuote,
            origin: "generated_v4" as const,
            verification: "exact" as const,
          }],
        },
      ],
    });
    const [approved, rejected] = reentryKnowledge.stateTransitions;
    if (!approved || !rejected) throw new Error("Expected re-entry transition participants.");
    const reentryBlocker = {
      id: "conflict-order-review",
      type: "hard_conflict",
      category: "hard_conflict",
      entryKey: "order-review",
      entryInstanceId: "order-review-instance",
      identityKey: "order-review-conflict",
      subject: "order:pending:manager-review",
      conflictType: "incompatible_transition_target",
      affectedCategory: "state_transition",
      participants: [approved, rejected].map((entry, index) => ({
        participantId: index === 0 ? "transition-approved" : "transition-rejected",
        category: "state_transition",
        entryKey: entry.id,
        entry,
        projection: {
          workflowName: entry.workflowName,
          fromState: entry.fromState ?? null,
          toState: entry.toState ?? null,
          triggerOrCondition: entry.triggerOrCondition,
          actor: entry.actor ?? null,
          moduleName: entry.moduleName ?? null,
        },
        semanticHash: `transition-semantic-${index + 1}`,
        concreteValue: entry.toState,
        evidenceRefs: entry.evidenceRefs,
        sourceSnapshotIds: [reentrySnapshotId],
        sourceWorkItemIds: [reentryWorkItemId],
        evidence: entry.evidence,
      })),
      evidenceIdentical: false,
      message: "Choose the supported transition target.",
    };
    const reentryManifest = [
      {
        sourceSnapshotId: "snapshot-decision",
        sourceWorkItemId: "decision",
        workItemType: "User Story",
        contentHash: "decision-hash",
        adoRevision: 1,
        sourceUpdatedAt: "2026-07-12T12:00:00.000Z",
        capturedAt: "2026-07-12T12:00:00.000Z",
      },
      {
        sourceSnapshotId: reentrySnapshotId,
        sourceWorkItemId: reentryWorkItemId,
        workItemType: "User Story",
        contentHash: "reentry-hash",
        adoRevision: 1,
        sourceUpdatedAt: "2026-07-12T12:00:00.000Z",
        capturedAt: "2026-07-12T12:00:00.000Z",
      },
    ];
    const reentryHashes = computeProjectKnowledgeHashes(reentryKnowledge);
    const reentryRow = draftRow({
      generation_mode: "automatic",
      status: "blocked",
      source_manifest_json: reentryManifest,
      source_fingerprint: computeProjectKnowledgeSourceFingerprint(reentryManifest),
      proposed_knowledge_json: reentryKnowledge,
      blockers_json: [reentryBlocker],
      metrics_json: firstPass.metrics,
      semantic_hash: reentryHashes.semanticKnowledgeHash,
      provenance_hash: reentryHashes.provenanceHash,
    });
    database.sqlGet.mockResolvedValue(reentryRow);
    database.sqlAll.mockResolvedValue([
      {
        id: "snapshot-decision",
        azure_work_item_id: "decision",
        fields_json: { acceptanceCriteria: "Retry count must be 3. Retry count must be 5." },
      },
      {
        id: reentrySnapshotId,
        azure_work_item_id: reentryWorkItemId,
        fields_json: { acceptanceCriteria: `${approvedQuote} ${rejectedQuote}` },
      },
    ]);

    await applyProjectKnowledgeConflictDecisions({
      scope,
      actor: "owner-1",
      draftId: "draft-child",
      draftVersion: `pkdv_${hashCanonicalValue({
        draftId: reentryRow.id,
        semanticHash: reentryHashes.semanticKnowledgeHash,
        provenanceHash: reentryHashes.provenanceHash,
        conflicts: [reentryBlocker.identityKey],
      }).slice(0, 32)}`,
      decisions: [{
        conflictId: reentryBlocker.id,
        action: "keep",
        participantId: "transition-approved",
      }],
    });

    const updates = database.sqlRun.mock.calls.filter(([sql]) => String(sql).includes("SET status = @status"));
    const reentryUpdate = updates.at(-1);
    if (!reentryUpdate) throw new Error("Expected the re-entry completion update.");
    const params = reentryUpdate[1] as { metricsJson: string; proposedKnowledgeJson: string; status: string };
    const reentryMetrics = JSON.parse(params.metricsJson) as Record<string, unknown>;
    const persisted = JSON.parse(params.proposedKnowledgeJson) as ProjectKnowledgeBase;

    expect(params.status).toBe("ready_to_publish");
    expect(persisted.stateTransitions).toEqual([
      expect.objectContaining({ id: "st-order-approved", toState: "Approved" }),
    ]);
    for (const metric of [
      "preConsolidationDuplicateIdentityCount",
      "paraphraseMergeCount",
      "rekeyCount",
      "atomicExtractionFailureCount",
    ]) {
      expect(reentryMetrics[metric]).toBe(firstPass.metrics[metric]);
    }
    expect(reentryMetrics.possibleTensions).toEqual([firstPass.retainedTension]);
    expect(reentryMetrics.possibleTensionCount).toBe(1);
    expect(reentryMetrics.possibleTensionCount).toBe((reentryMetrics.possibleTensions as unknown[]).length);
  });

  it("carries the rule winner's atomic constraint and module associations", async () => {
    const result = await applyBusinessRuleCombination({ ruleWinnerKeepsMetadata: true });

    expect(result.persisted.businessRules).toEqual([
      expect.objectContaining({
        id: "br-retry-first",
        constraint: expect.objectContaining({ value: "5", valueType: "number" }),
        moduleAssociations: ["Orders", "Payments"],
      }),
    ]);
  });

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
    expect(database.sqlRun).toHaveBeenCalledWith(
      expect.stringContaining("compiler_contract_upgraded"),
      expect.objectContaining({
        projectId: scope.projectId,
        azureProjectId: scope.azureProjectId,
        compilerContractVersion: PROJECT_KNOWLEDGE_COMPILER_CONTRACT_VERSION,
      }),
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

  it("supersedes stale compiler-contract drafts lazily on read", async () => {
    database.sqlGet.mockResolvedValue(draftRow({
      status: "superseded",
      status_reason: "compiler_contract_upgraded",
      compiler_contract_version: "4.0.0",
    }));

    const result = await getProjectKnowledgeDraft({ scope, draftId: "draft-child" });

    expect(result).toMatchObject({
      persistedStatus: "superseded",
      statusReason: "compiler_contract_upgraded",
      compilerContractVersion: "4.0.0",
      regenerateRequired: true,
    });
    expect(database.sqlRun).toHaveBeenCalledWith(
      expect.stringContaining("status_reason = 'compiler_contract_upgraded'"),
      expect.objectContaining({
        projectId: scope.projectId,
        azureProjectId: scope.azureProjectId,
        compilerContractVersion: PROJECT_KNOWLEDGE_COMPILER_CONTRACT_VERSION,
      }),
      undefined,
    );
  });

  it("rejects decisions for a stale compiler-contract draft", async () => {
    database.sqlGet.mockResolvedValue(draftRow({
      status: "superseded",
      status_reason: "compiler_contract_upgraded",
      compiler_contract_version: "4.0.0",
      proposed_knowledge_json: emptyKnowledge,
    }));

    await expect(applyProjectKnowledgeConflictDecisions({
      scope,
      actor: "owner-1",
      draftId: "draft-child",
      draftVersion: "stale-version",
      decisions: [],
    })).rejects.toMatchObject({ code: AppErrorCode.KnowledgeContractMismatch });
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

