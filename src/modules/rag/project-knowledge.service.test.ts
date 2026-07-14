import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  sqlAll: vi.fn(),
  sqlGet: vi.fn(),
  sqlRun: vi.fn(),
  withTransaction: vi.fn(),
  createId: vi.fn(),
  nowIso: vi.fn(),
}));
const writeAuditLog = vi.hoisted(() => vi.fn());
const compiledService = vi.hoisted(() => ({
  recordProjectKnowledgeLog: vi.fn(),
  recordProjectKnowledgeRevision: vi.fn(),
  runProjectKnowledgeLint: vi.fn(),
}));
const refreshProjectKnowledgeSearchIndex = vi.hoisted(() => vi.fn());
const draftService = vi.hoisted(() => ({
  beginProjectKnowledgeDraft: vi.fn(),
  completeProjectKnowledgeDraft: vi.fn(),
  failProjectKnowledgeDraft: vi.fn(),
  getProjectKnowledgeDraft: vi.fn(),
  heartbeatProjectKnowledgeDraft: vi.fn(),
  loadCurrentProjectKnowledgeSourceManifest: vi.fn(),
  loadProjectKnowledgeManualBatchResults: vi.fn(),
  publishProjectKnowledgeDraft: vi.fn(),
  saveProjectKnowledgeManualBatchResult: vi.fn(),
  setProjectKnowledgeDraftCompilationMode: vi.fn(),
  storeProjectKnowledgeManualDraftBatches: vi.fn(),
  tryDeterministicProjectKnowledgeRebase: vi.fn(),
}));

vi.mock("@/modules/shared/infrastructure/database/db", () => database);
vi.mock("@/modules/audit/audit.service", () => ({ writeAuditLog }));
vi.mock("@/modules/rag/project-knowledge-compiled.service", () => compiledService);
vi.mock("@/modules/rag/context-chatbot-retrieval.service", () => ({ refreshProjectKnowledgeSearchIndex }));
vi.mock("@/modules/rag/project-context-schema.service", () => ({ ensureProjectContextSyncSchema: vi.fn() }));
vi.mock("@/modules/rag/project-knowledge-draft.service", () => draftService);
vi.mock("@/modules/rag/project-knowledge-migration.service", () => ({ backfillProjectKnowledgeCompilerFoundation: vi.fn() }));

import { projectKnowledgeExtractionPrompt } from "@/modules/llm/prompts";
import { AppError, AppErrorCode } from "@/modules/shared/errors/app-error";
import { fakeLlmProvider, projectScope } from "@/test/factories";
import type { ProjectKnowledgeBase, ProjectKnowledgeEvidenceRef } from "./project-knowledge.schema";
import { detectProjectKnowledgeHardConflicts } from "./project-knowledge-conflicts";
import {
  buildProjectKnowledgeManualDraft,
  loadProjectKnowledgeContext,
  previewGeneratedProjectKnowledgeBase,
  saveManualProjectKnowledgeBaseFromBatches,
  validateProjectKnowledgeExternalOutput,
} from "./project-knowledge.service";

type WorkItemRow = {
  azure_work_item_id: string;
  work_item_type: string;
  title: string;
  description: string | null;
  acceptance_criteria: string | null;
  state: string | null;
  tags: string | null;
  area_path: string | null;
  iteration_path: string | null;
  updated_date: string | null;
  content_hash: string | null;
  current_snapshot_id: string | null;
};

function workItemRow(overrides: Partial<WorkItemRow> = {}): WorkItemRow {
  return {
    azure_work_item_id: "1",
    work_item_type: "User Story",
    title: "Customer checks out",
    description: null,
    acceptance_criteria: null,
    state: "Active",
    tags: null,
    area_path: null,
    iteration_path: null,
    updated_date: null,
    content_hash: null,
    current_snapshot_id: "snapshot-1",
    ...overrides,
  };
}

function setWorkItems(rows: WorkItemRow[]) {
  const snapshots = rows.map((row) => ({
    id: row.current_snapshot_id ?? `snapshot-${row.azure_work_item_id}`,
    azure_work_item_id: row.azure_work_item_id,
    work_item_type: row.work_item_type,
    content_hash: row.content_hash,
    source_updated_at: row.updated_date,
    fields_json: {
      title: row.title,
      description: row.description,
      acceptanceCriteria: row.acceptance_criteria,
      state: row.state,
      tags: row.tags,
      areaPath: row.area_path,
      iterationPath: row.iteration_path,
    },
  }));
  const sourceManifest = snapshots.map((snapshot) => ({
    sourceSnapshotId: snapshot.id,
    sourceWorkItemId: snapshot.azure_work_item_id,
    workItemType: snapshot.work_item_type,
    contentHash: snapshot.content_hash ?? `hash-${snapshot.azure_work_item_id}`,
    adoRevision: null,
    sourceUpdatedAt: snapshot.source_updated_at,
    capturedAt: "2026-07-06T00:00:00.000Z",
  }));
  database.sqlAll.mockResolvedValue(snapshots);
  const draft = { id: "draft-1", status: "awaiting_input", sourceManifest };
  draftService.beginProjectKnowledgeDraft.mockResolvedValue(draft);
  draftService.getProjectKnowledgeDraft.mockResolvedValue(draft);
}

type KnowledgeModule = ProjectKnowledgeBase["modules"][number];
type KnowledgeBusinessRule = ProjectKnowledgeBase["businessRules"][number];
type KnowledgeGlossaryTerm = ProjectKnowledgeBase["glossary"][number];
type KnowledgeStateTransition = ProjectKnowledgeBase["stateTransitions"][number];
type KnowledgeDependency = ProjectKnowledgeBase["crossDependencies"][number];

function kbEvidenceRef(
  sourceWorkItemId: string,
  sourceSnapshotId = `snapshot-${sourceWorkItemId}`,
  quote = `Evidence from ${sourceWorkItemId}`,
): ProjectKnowledgeEvidenceRef {
  return {
    sourceSnapshotId,
    sourceWorkItemId,
    sourceField: "description",
    quote,
    origin: "generated_v2",
    verification: "exact",
  };
}

function kbModule(overrides: Partial<KnowledgeModule> = {}): KnowledgeModule {
  return {
    id: "mod-auth",
    name: "Authentication",
    description: "Handles login.",
    sourceWorkItemIds: ["1"],
    evidence: "Login story",
    ...overrides,
  };
}

function kbBusinessRule(overrides: Partial<KnowledgeBusinessRule> = {}): KnowledgeBusinessRule {
  return {
    id: "br-1",
    rule: "Checkout requires payment.",
    sourceField: "acceptanceCriteria",
    sourceWorkItemIds: ["1"],
    evidence: "AC on story 1",
    ...overrides,
  };
}

function kbGlossaryTerm(overrides: Partial<KnowledgeGlossaryTerm> = {}): KnowledgeGlossaryTerm {
  return {
    term: "Customer",
    type: "term",
    definition: "A person.",
    sourceWorkItemIds: ["1"],
    evidence: "Story 1 mentions customers",
    ...overrides,
  };
}

function knowledgeBase(overrides: Partial<ProjectKnowledgeBase> = {}): ProjectKnowledgeBase {
  return {
    modules: [],
    businessRules: [],
    stateTransitions: [],
    glossary: [],
    crossDependencies: [],
    ...overrides,
  };
}

function snapshotRow(kb: ProjectKnowledgeBase, overrides: Record<string, unknown> = {}) {
  return {
    id: "pkb-existing",
    prompt_version: "v1",
    provider: "openai",
    model_name: "gpt-test",
    source_work_item_count: 2,
    raw_output: null,
    validated_output: JSON.stringify(kb),
    status: "Success",
    error_details: null,
    extracted_at: "2026-02-01T00:00:00.000Z",
    created_at: "2026-02-01T00:00:00.000Z",
    updated_at: "2026-02-01T00:00:00.000Z",
    active_revision_id: "revision-1",
    source_fingerprint: "fingerprint-1",
    semantic_hash: "semantic-1",
    provenance_hash: "provenance-1",
    compiler_contract_version: "2.0.0",
    freshness_status: "current",
    provenance_status: "verified",
    compiler_compatibility: "current",
    stale_since: null,
    stale_reason_json: "[]",
    ...overrides,
  };
}

function kbStateTransition(overrides: Partial<KnowledgeStateTransition> = {}): KnowledgeStateTransition {
  return {
    id: "transition-order",
    workflowName: "Order lifecycle",
    fromState: "Pending",
    toState: "Approved",
    triggerOrCondition: "Payment succeeds",
    sourceWorkItemIds: ["1"],
    evidence: "Approved after payment",
    ...overrides,
  };
}

function kbDependency(overrides: Partial<KnowledgeDependency> = {}): KnowledgeDependency {
  return {
    id: "dep-checkout-payment",
    sourceModule: "Checkout",
    targetModule: "Payment",
    dependencyType: "uses",
    description: "Checkout uses payment.",
    sourceWorkItemIds: ["1"],
    evidence: "Checkout calls payment",
    ...overrides,
  };
}

// Routes the two sqlGet lookups the incremental selection performs: the saved
// snapshot (project_knowledge_base) and the latest revision's source hashes.
function stubExistingKnowledge(input: {
  snapshot?: Record<string, unknown>;
  sourceWorkItemHashes?: Record<string, string | null>;
}) {
  database.sqlGet.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM project_knowledge_base")) return input.snapshot;
    if (sql.includes("FROM project_knowledge_revisions")) {
      return input.sourceWorkItemHashes
        ? { source_change_summary_json: JSON.stringify({ sourceWorkItemHashes: input.sourceWorkItemHashes }) }
        : undefined;
    }
    return undefined;
  });
}

function expectAppError(run: () => unknown): AppError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error("Expected the call to throw an AppError.");
}

beforeEach(() => {
  vi.clearAllMocks();
  database.sqlAll.mockResolvedValue([]);
  database.sqlGet.mockResolvedValue(undefined);
  database.sqlRun.mockResolvedValue(0);
  database.withTransaction.mockImplementation(async (callback: (client: unknown) => unknown) => callback({}));
  database.createId.mockReturnValue("pkb-test");
  database.nowIso.mockReturnValue("2026-07-06T00:00:00.000Z");
  draftService.beginProjectKnowledgeDraft.mockResolvedValue({ id: "draft-1", status: "awaiting_input", sourceManifest: [] });
  draftService.completeProjectKnowledgeDraft.mockImplementation(async (input: { knowledgeBase: ProjectKnowledgeBase }) => ({
    id: "draft-1",
    status: "ready_for_review",
    knowledgeBase: input.knowledgeBase,
    proposedKnowledge: input.knowledgeBase,
    rawOutput: (input as { rawOutput?: string }).rawOutput,
  }));
  draftService.storeProjectKnowledgeManualDraftBatches.mockResolvedValue({
    draft: { id: "draft-1" },
    carriedBatches: [],
  });
});

describe("validateProjectKnowledgeExternalOutput", () => {
  const validPayload = {
    modules: [{
      id: "mod-checkout",
      name: "Checkout",
      description: "",
      sourceWorkItemIds: [" 1", "1", "2"],
      evidence: "Checkout story",
    }],
    businessRules: [],
    stateTransitions: [],
    glossary: [{
      term: "Customer",
      type: "Business Entity",
      definition: "A buyer.",
      sourceWorkItemIds: ["1"],
      evidence: "Story 1",
    }],
    crossDependencies: [],
  };

  it("accepts a valid payload and normalizes it through the schema", () => {
    const result = validateProjectKnowledgeExternalOutput(JSON.stringify(validPayload));

    // Duplicate/whitespace source ids collapse, blank description falls back to
    // evidence, and free-form glossary types normalize to the enum.
    expect(result.modules).toEqual([expect.objectContaining({
      id: "mod-checkout",
      description: "Checkout story",
      sourceWorkItemIds: ["1", "2"],
    })]);
    expect(result.glossary[0].type).toBe("business_entity");
  });

  it("accepts JSON pasted with prose and markdown fences around it", () => {
    const rawOutput = `Here is the knowledge base:\n\n\`\`\`json\n${JSON.stringify(validPayload)}\n\`\`\`\nLet me know if you need anything else.`;
    expect(validateProjectKnowledgeExternalOutput(rawOutput).modules).toHaveLength(1);
  });

  it("rejects truncated output with an actionable invalid-JSON error", () => {
    const full = JSON.stringify(validPayload);
    const error = expectAppError(() => validateProjectKnowledgeExternalOutput(full.slice(0, full.length - 30)));

    expect(error.code).toBe(AppErrorCode.InvalidJson);
    expect(error.message).toContain("External LLM output was not valid JSON");
    expect(error.userMessage).toContain("was not valid JSON");
  });

  it("rejects empty input with a paste-the-response message", () => {
    const error = expectAppError(() => validateProjectKnowledgeExternalOutput("   "));

    expect(error.code).toBe(AppErrorCode.InvalidJson);
    expect(error.message).toBe("Paste the external LLM JSON response before continuing.");
  });

  it("rejects schema-invalid JSON and names the failing path", () => {
    const error = expectAppError(() => validateProjectKnowledgeExternalOutput(JSON.stringify({
      modules: [{ id: "m1", name: "M", sourceWorkItemIds: [], evidence: "E" }],
    })));

    expect(error.code).toBe(AppErrorCode.SchemaValidation);
    expect(error.message).toContain("failed schema validation for ProjectKnowledgeBase");
    expect(error.message).toContain("modules.0.sourceWorkItemIds");
  });
});

describe("buildProjectKnowledgeManualDraft batching", () => {
  it("keeps small work items in a single batch and normalizes row content into the prompt", async () => {
    setWorkItems([workItemRow({
      description: "<p>Allow checkout</p>",
      acceptance_criteria: "<ul><li>Given cart</li></ul>",
      tags: "checkout;  payments; ",
      content_hash: "h1",
    })]);

    const draft = await buildProjectKnowledgeManualDraft({ scope: projectScope() });

    expect(draft.batchCount).toBe(1);
    expect(draft.mode).toBe("full");
    expect(draft.batches[0].systemPrompt).toBe(projectKnowledgeExtractionPrompt.system);
    expect(draft.batches[0].prompt).toContain("iTestFlow Knowledge Base Full Recompile");
    expect(draft.batches[0].prompt).not.toContain("Batch 1 of");

    const userPrompt = JSON.parse(draft.batches[0].userPrompt);
    // Single batch: no batch metadata, extraction mode mirrors the compile mode.
    expect(userPrompt.batchIndex).toBeUndefined();
    expect(userPrompt.extractionMode).toBe("full");
    // HTML is stripped, tags split on ";", and the content hash never reaches the prompt.
    expect(userPrompt.workItems).toEqual([{
      id: "1",
      sourceSnapshotId: "snapshot-1",
      workItemType: "User Story",
      title: "Customer checks out",
      state: "Active",
      description: "Allow checkout",
      acceptanceCriteria: "Given cart",
      tags: ["checkout", "payments"],
    }]);
  });

  it("splits into a new batch only when the accumulated input exceeds the size cap", async () => {
    // ~8k chars each: two fit under the 18k input cap, the third overflows.
    setWorkItems([1, 2, 3].map((id) => workItemRow({
      azure_work_item_id: String(id),
      title: `Item ${id}`,
      description: "d".repeat(8000),
    })));

    const draft = await buildProjectKnowledgeManualDraft({ scope: projectScope() });

    expect(draft.batchCount).toBe(2);
    expect(draft.batches.map((batch) => batch.workItemCount)).toEqual([2, 1]);
    const firstBatch = JSON.parse(draft.batches[0].userPrompt);
    const secondBatch = JSON.parse(draft.batches[1].userPrompt);
    expect(firstBatch.workItems.map((item: { id: string }) => item.id)).toEqual(["1", "2"]);
    expect(secondBatch.workItems.map((item: { id: string }) => item.id)).toEqual(["3"]);
    // Multi-batch prompts carry batch metadata and a batch-numbered title.
    expect(firstBatch).toMatchObject({ extractionMode: "batch", batchIndex: 1, batchCount: 2 });
    expect(draft.batches[0].prompt).toContain("Batch 1 of 2");
    expect(draft.batches[1].prompt).toContain("Batch 2 of 2");
  });

  it("gives an oversized work item its own batch instead of an empty one", async () => {
    setWorkItems([
      workItemRow({ azure_work_item_id: "1", description: "d".repeat(20000) }),
      workItemRow({ azure_work_item_id: "2", title: "Small item" }),
    ]);

    const draft = await buildProjectKnowledgeManualDraft({ scope: projectScope() });

    expect(draft.batchCount).toBe(2);
    expect(draft.batches.map((batch) => batch.workItemCount)).toEqual([1, 1]);
  });

  it("requires indexed project context before building a draft", async () => {
    await expect(buildProjectKnowledgeManualDraft({ scope: projectScope() }))
      .rejects.toThrow("Fetch and index project context before extracting the knowledge base.");
  });
});

describe("work item selection for compilation", () => {
  it("prompts every work item in full mode and checks for source-linked existing knowledge", async () => {
    setWorkItems([
      workItemRow({ azure_work_item_id: "1" }),
      workItemRow({ azure_work_item_id: "2" }),
    ]);

    const draft = await buildProjectKnowledgeManualDraft({ scope: projectScope(), mode: "full" });

    expect(draft.mode).toBe("full");
    expect(draft.sourceWorkItemCount).toBe(2);
    expect(draft.changedSourceWorkItemCount).toBe(2);
    expect(draft.retiredSourceWorkItemCount).toBe(0);
    expect(database.sqlGet).toHaveBeenCalledWith(
      expect.stringContaining("FROM project_knowledge_base"),
      expect.objectContaining({ projectId: projectScope().projectId }),
    );
  });

  it("falls back to a full compile when no knowledge base is saved yet", async () => {
    setWorkItems([
      workItemRow({ azure_work_item_id: "1" }),
      workItemRow({ azure_work_item_id: "2" }),
    ]);

    const draft = await buildProjectKnowledgeManualDraft({ scope: projectScope(), mode: "incremental" });

    expect(draft.requestedMode).toBe("incremental");
    expect(draft.mode).toBe("full");
    expect(draft.fallbackReason).toContain("first compile must include every active work item");
    expect(draft.sourceWorkItemCount).toBe(2);
  });

  it("selects only hash-changed work items and reports retired sources", async () => {
    setWorkItems([
      workItemRow({ azure_work_item_id: "1", content_hash: "h1" }),
      workItemRow({ azure_work_item_id: "2", title: "Changed item", content_hash: "h2-new" }),
    ]);
    stubExistingKnowledge({
      snapshot: snapshotRow(knowledgeBase({ modules: [kbModule()] })),
      // "1" unchanged, "2" changed, "3" no longer active -> retired.
      sourceWorkItemHashes: { "1": "h1", "2": "h2-old", "3": "h3" },
    });

    const draft = await buildProjectKnowledgeManualDraft({ scope: projectScope(), mode: "incremental" });

    expect(draft.mode).toBe("incremental");
    expect(draft.fallbackReason).toBeUndefined();
    expect(draft.totalSourceWorkItemCount).toBe(2);
    expect(draft.sourceWorkItemCount).toBe(1);
    expect(draft.changedSourceWorkItemCount).toBe(1);
    expect(draft.retiredSourceWorkItemCount).toBe(1);

    const userPrompt = JSON.parse(draft.batches[0].userPrompt);
    expect(userPrompt.workItems.map((item: { id: string }) => item.id)).toEqual(["2"]);
    expect(userPrompt.knowledgeCompileMode).toBe("incremental");
    expect(userPrompt.incrementalInstruction).toContain("Reconcile every relevantExistingKnowledge entry");
  });

  it("uses the snapshot timestamp as baseline when the saved revision has no source hashes", async () => {
    setWorkItems([
      workItemRow({ azure_work_item_id: "1", updated_date: "2026-01-15T00:00:00.000Z" }),
      workItemRow({ azure_work_item_id: "2", updated_date: "2026-03-01T00:00:00.000Z" }),
    ]);
    stubExistingKnowledge({
      // Knowledge cites "9", which is no longer an active work item -> retired.
      snapshot: snapshotRow(
        knowledgeBase({ modules: [kbModule({ sourceWorkItemIds: ["1", "9"] })] }),
        { extracted_at: "2026-02-01T00:00:00.000Z" },
      ),
    });

    const draft = await buildProjectKnowledgeManualDraft({ scope: projectScope(), mode: "incremental" });

    expect(draft.mode).toBe("incremental");
    expect(draft.fallbackReason).toContain("does not include source hashes");
    // Only the item updated after the snapshot's extraction time is prompted.
    expect(draft.changedSourceWorkItemCount).toBe(1);
    expect(draft.retiredSourceWorkItemCount).toBe(1);
    const userPrompt = JSON.parse(draft.batches[0].userPrompt);
    expect(userPrompt.workItems.map((item: { id: string }) => item.id)).toEqual(["2"]);
  });
});

describe("loadProjectKnowledgeContext", () => {
  it("uses trusted compiled knowledge only when every health dimension is current", async () => {
    database.sqlGet.mockResolvedValue(snapshotRow(knowledgeBase({ modules: [kbModule()] })));

    const context = await loadProjectKnowledgeContext({ scope: projectScope(), consumer: "test_consumer" });

    expect(context.usage).toBe("trusted_compiled");
    expect(context.promptNotice).toBeNull();
    expect(context.health).toMatchObject({ rawContextRequired: false, trustedCompiledRetrieval: true });
    expect(compiledService.recordProjectKnowledgeLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "knowledge.consumed",
        metadata: expect.objectContaining({ usage: "trusted_compiled" }),
      }),
    );
  });

  it.each([
    ["stale source", { freshness_status: "stale" }],
    ["partial provenance", { provenance_status: "partial" }],
    ["incompatible compiler", { compiler_compatibility: "incompatible" }],
  ])("keeps raw evidence authoritative for %s", async (_label, overrides) => {
    database.sqlGet.mockResolvedValue(snapshotRow(knowledgeBase({ modules: [kbModule()] }), overrides));

    const context = await loadProjectKnowledgeContext({ scope: projectScope() });

    expect(context.usage).toBe("raw_wins");
    expect(context.health).toMatchObject({ rawContextRequired: true, trustedCompiledRetrieval: false });
    expect(context.promptNotice).toContain("Knowledge authority notice:");
    expect(context.promptNotice).toContain(
      "Treat current raw work-item evidence as authoritative; it wins every conflict with compiled knowledge.",
    );
  });
});

describe("automatic v2 reconciliation prompts", () => {
  it("consolidates duplicates produced inside one automatic extraction batch", async () => {
    setWorkItems([workItemRow({ azure_work_item_id: "1", content_hash: "h1" })]);
    const provider = fakeLlmProvider({
      structuredOutput: knowledgeBase({
        modules: [
          kbModule({ evidence: "Login story" }),
          kbModule({
            id: "MOD_AUTH",
            name: " authentication ",
            description: " handles login. ",
            evidence: "Session story",
          }),
        ],
      }),
    });

    const draft = await previewGeneratedProjectKnowledgeBase({
      scope: projectScope(),
      actor: "qa",
      provider,
      mode: "full",
    });

    expect(draft.knowledgeBase.modules).toHaveLength(1);
    expect(draft.knowledgeBase.modules[0]).toMatchObject({
      id: "mod-auth",
      name: "Authentication",
      description: "Handles login.",
      evidence: "Login story | Session story",
    });
    expect(draft.automaticDuplicateConsolidationCount).toBe(1);
    expect(JSON.parse(draft.rawOutput)).toMatchObject({
      consolidation: "local-deterministic",
      splitCallCount: 1,
      automaticDuplicateConsolidationCount: 1,
    });
    expect(draftService.completeProjectKnowledgeDraft).toHaveBeenCalledWith(expect.objectContaining({
      metrics: expect.objectContaining({ automaticDuplicateConsolidationCount: 1 }),
    }));
  });

  it("uses the deterministic no-LLM path for zero-change and retired-only runs", async () => {
    const provider = fakeLlmProvider({ structuredOutput: knowledgeBase() });
    const existing = knowledgeBase({
      modules: [
        kbModule({ id: "current", sourceWorkItemIds: ["1"] }),
        kbModule({ id: "retired", sourceWorkItemIds: ["2"] }),
      ],
    });
    setWorkItems([workItemRow({ azure_work_item_id: "1", content_hash: "h1" })]);
    stubExistingKnowledge({
      snapshot: snapshotRow(existing),
      sourceWorkItemHashes: { "1": "h1", "2": "h2" },
    });

    const retiredOnly = await previewGeneratedProjectKnowledgeBase({
      scope: projectScope(),
      actor: "qa",
      provider,
      mode: "incremental",
    });
    expect(provider.generateStructuredOutput).not.toHaveBeenCalled();
    expect(retiredOnly.retiredSourceWorkItemIds).toEqual(["2"]);
    expect(retiredOnly.knowledgeBase.modules.map((module) => module.id)).toEqual(["current"]);
    expect(retiredOnly.splitCallCount).toBe(0);

    vi.clearAllMocks();
    setWorkItems([workItemRow({ azure_work_item_id: "1", content_hash: "h1" })]);
    stubExistingKnowledge({
      snapshot: snapshotRow(knowledgeBase({ modules: [kbModule({ id: "current", sourceWorkItemIds: ["1"] })] })),
      sourceWorkItemHashes: { "1": "h1" },
    });
    draftService.completeProjectKnowledgeDraft.mockImplementation(async (input: { knowledgeBase: ProjectKnowledgeBase }) => ({
      id: "draft-2",
      status: "ready_for_review",
      knowledgeBase: input.knowledgeBase,
      proposedKnowledge: input.knowledgeBase,
      blockers: [],
    }));
    const current = await previewGeneratedProjectKnowledgeBase({
      scope: projectScope(),
      actor: "qa",
      provider,
      mode: "incremental",
    });
    expect(provider.generateStructuredOutput).not.toHaveBeenCalled();
    expect(current.alreadyCurrent).toBe(true);
    expect(current.splitCallCount).toBe(0);
  });

  it("sends every exact source-linked entry across split calls and excludes unrelated knowledge", async () => {
    setWorkItems([
      workItemRow({ azure_work_item_id: "1", content_hash: "h1-new" }),
      workItemRow({ azure_work_item_id: "2", content_hash: "h2" }),
    ]);
    const existing = knowledgeBase({
      modules: [
        kbModule({ id: "exact-a", name: "Exact A", description: "a".repeat(35_000), sourceWorkItemIds: ["1"] }),
        kbModule({ id: "exact-b", name: "Exact B", description: "b".repeat(35_000), sourceWorkItemIds: ["1"] }),
        kbModule({ id: "unrelated", name: "Unrelated", description: "Must not be sent", sourceWorkItemIds: ["2"] }),
      ],
    });
    stubExistingKnowledge({
      snapshot: snapshotRow(existing),
      sourceWorkItemHashes: { "1": "h1-old", "2": "h2" },
    });
    const provider = Object.assign(fakeLlmProvider({ structuredOutput: knowledgeBase() }), {
      maxInputTokens: 16_000,
      inputTokenLimitSource: "unknown_fallback" as const,
    });

    const draft = await previewGeneratedProjectKnowledgeBase({
      scope: projectScope(),
      actor: "qa",
      provider,
      mode: "incremental",
    });

    expect(provider.generateStructuredOutput).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(provider.generateStructuredOutput).mock.calls as unknown as Array<[{ user: string }]>;
    const promptedIds = calls.flatMap(([call]) => {
      const user = JSON.parse(call.user);
      return user.relevantExistingKnowledge.modules.map((module: { id: string }) => module.id);
    });
    expect(promptedIds.sort()).toEqual(["exact-a", "exact-b"]);
    expect(promptedIds).not.toContain("unrelated");
    expect(draft.splitCallCount).toBe(2);
    expect(draft.inputTokenLimitSource).toBe("unknown_fallback");
    expect(draftService.heartbeatProjectKnowledgeDraft).toHaveBeenCalledTimes(2);
    expect(draftService.heartbeatProjectKnowledgeDraft).toHaveBeenCalledWith({
      scope: projectScope(),
      draftId: "draft-1",
    });
    expect(draftService.completeProjectKnowledgeDraft).toHaveBeenCalledWith(
      expect.objectContaining({ touchedSourceWorkItemIds: ["1"] }),
    );
  });

  it("fails the draft when one exact source-linked entry cannot fit the rendered budget", async () => {
    setWorkItems([workItemRow({ azure_work_item_id: "1", content_hash: "h1-new" })]);
    stubExistingKnowledge({
      snapshot: snapshotRow(knowledgeBase({
        modules: [kbModule({ id: "oversized", description: "x".repeat(100_000), sourceWorkItemIds: ["1"] })],
      })),
      sourceWorkItemHashes: { "1": "h1-old" },
    });
    const provider = Object.assign(fakeLlmProvider({ structuredOutput: knowledgeBase() }), {
      maxInputTokens: 16_000,
      inputTokenLimitSource: "unknown_fallback" as const,
    });

    await expect(previewGeneratedProjectKnowledgeBase({
      scope: projectScope(),
      actor: "qa",
      provider,
      mode: "incremental",
    })).rejects.toThrow(
      "Exact source-linked knowledge entry modules:oversized cannot fit the rendered 16,000-token input budget.",
    );

    expect(provider.generateStructuredOutput).not.toHaveBeenCalled();
    expect(draftService.failProjectKnowledgeDraft).toHaveBeenCalledWith(expect.objectContaining({
      draftId: "draft-1",
      reason: expect.stringContaining("cannot fit the rendered 16,000-token input budget"),
    }));
  });
});

describe("saveManualProjectKnowledgeBaseFromBatches", () => {
  it("finalizes from persisted validated batches instead of client-supplied copies", async () => {
    const persisted = knowledgeBase({ modules: [kbModule({ description: "Persisted answer" })] });
    const clientCopy = knowledgeBase({ modules: [kbModule({ description: "Untrusted client copy" })] });
    draftService.loadProjectKnowledgeManualBatchResults.mockResolvedValue({
      batchCount: 1,
      validatedCount: 1,
      partialKnowledgeBases: [persisted],
      rawOutputs: [JSON.stringify(persisted)],
    });
    setWorkItems([workItemRow()]);

    const draft = await saveManualProjectKnowledgeBaseFromBatches({
      scope: projectScope(),
      actor: "qa",
      draftId: "draft-1",
      partialKnowledgeBases: [clientCopy],
      mode: "full",
    });

    expect(draft.knowledgeBase.modules[0].description).toBe("Persisted answer");
    expect(draftService.completeProjectKnowledgeDraft).toHaveBeenCalledWith(
      expect.objectContaining({ knowledgeBase: persisted }),
    );
  });

  it("rejects finalization until every persisted batch is validated", async () => {
    draftService.loadProjectKnowledgeManualBatchResults.mockResolvedValue({
      batchCount: 2,
      validatedCount: 1,
      partialKnowledgeBases: [knowledgeBase()],
      rawOutputs: ["{}"],
    });

    await expect(saveManualProjectKnowledgeBaseFromBatches({
      scope: projectScope(),
      actor: "qa",
      draftId: "draft-1",
      partialKnowledgeBases: [],
      mode: "full",
    })).rejects.toThrow("Validate every persisted manual batch");
    expect(draftService.completeProjectKnowledgeDraft).not.toHaveBeenCalled();
  });

  it("automatically consolidates equivalent and same-snapshot descriptive duplicates", async () => {
    setWorkItems([
      workItemRow({ azure_work_item_id: "1" }),
      workItemRow({ azure_work_item_id: "2" }),
    ]);
    const batchOne = knowledgeBase({
      modules: [kbModule({ evidenceRefs: [kbEvidenceRef("1", "snapshot-shared", "Login story")] })],
      businessRules: [kbBusinessRule()],
      glossary: [kbGlossaryTerm({ evidenceRefs: [kbEvidenceRef("1", "snapshot-shared", "Customer is mentioned")] })],
    });
    const batchTwo = knowledgeBase({
      modules: [
        // "MOD_AUTH" normalizes to the same key as "mod-auth".
        kbModule({
          id: "MOD_AUTH",
          description: "Handles login and sessions.",
          sourceWorkItemIds: ["1"],
          evidence: "Session story",
          evidenceRefs: [kbEvidenceRef("1", "snapshot-shared", "Session story")],
        }),
        kbModule({ id: "mod-pay", name: "Payments", description: "Handles payments.", sourceWorkItemIds: ["2"], evidence: "Payment story" }),
      ],
      businessRules: [kbBusinessRule({ id: "br-2", sourceField: "acceptance_criteria", sourceWorkItemIds: ["2"], evidence: "Description on story 2" })],
      glossary: [kbGlossaryTerm({
        type: "business_entity",
        definition: "A person who buys products.",
        sourceWorkItemIds: ["1"],
        evidence: "Story 2",
        evidenceRefs: [kbEvidenceRef("1", "snapshot-shared", "Customer buys products")],
      })],
    });

    const snapshot = await saveManualProjectKnowledgeBaseFromBatches({
      scope: projectScope(),
      actor: "qa",
      partialKnowledgeBases: [batchOne, batchTwo],
    });

    expect(snapshot.knowledgeBase.modules).toEqual([
      {
        id: "mod-auth",
        name: "Authentication",
        description: "Handles login and sessions.",
        sourceWorkItemIds: ["1"],
        evidence: "Login story | Session story",
        evidenceRefs: [
          kbEvidenceRef("1", "snapshot-shared", "Login story"),
          kbEvidenceRef("1", "snapshot-shared", "Session story"),
        ],
      },
      {
        id: "mod-pay",
        name: "Payments",
        description: "Handles payments.",
        sourceWorkItemIds: ["2"],
        evidence: "Payment story",
      },
    ]);
    expect(snapshot.knowledgeBase.businessRules).toEqual([expect.objectContaining({
      id: "br-1",
      rule: "Checkout requires payment.",
      sourceWorkItemIds: ["1", "2"],
      evidence: "AC on story 1 | Description on story 2",
    })]);
    expect(snapshot.knowledgeBase.glossary).toEqual([expect.objectContaining({
      term: "Customer",
      type: "business_entity",
      definition: "A person who buys products.",
      sourceWorkItemIds: ["1"],
      evidence: "Customer buys products | Customer is mentioned",
    })]);

    const rawOutput = JSON.parse(snapshot.rawOutput ?? "{}");
    expect(rawOutput.consolidationMode).toBe("local-deterministic");
    expect(rawOutput.mode).toBe("full");
    expect(rawOutput.automaticDuplicateConsolidationCount).toBe(3);
    expect(draftService.completeProjectKnowledgeDraft).toHaveBeenCalledWith(expect.objectContaining({
      metrics: expect.objectContaining({ automaticDuplicateConsolidationCount: 3 }),
    }));
    expect(writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: "rag.extract_project_knowledge_base.manual_batch_complete",
      status: "Success",
      details: expect.objectContaining({
        mode: "full",
        batchCount: 2,
        automaticDuplicateConsolidationCount: 3,
      }),
    }));
  });

  it("preserves materially different and different-source variants for hard-conflict review", async () => {
    setWorkItems([
      workItemRow({ azure_work_item_id: "1" }),
      workItemRow({ azure_work_item_id: "2" }),
    ]);
    draftService.completeProjectKnowledgeDraft.mockImplementationOnce(async (input: {
      knowledgeBase: ProjectKnowledgeBase;
      rawOutput?: string;
    }) => ({
      id: "draft-1",
      status: "blocked",
      knowledgeBase: input.knowledgeBase,
      proposedKnowledge: input.knowledgeBase,
      rawOutput: input.rawOutput,
      blockers: detectProjectKnowledgeHardConflicts(input.knowledgeBase).map((conflict) => ({
        type: "hard_conflict",
        ...conflict,
      })),
    }));

    const snapshot = await saveManualProjectKnowledgeBaseFromBatches({
      scope: projectScope(),
      actor: "qa",
      partialKnowledgeBases: [
        knowledgeBase({
          modules: [kbModule({ evidenceRefs: [kbEvidenceRef("1")] })],
          businessRules: [kbBusinessRule({ rule: "Retry limit is 3", evidenceRefs: [kbEvidenceRef("1")] })],
          stateTransitions: [kbStateTransition({ evidenceRefs: [kbEvidenceRef("1")] })],
          glossary: [kbGlossaryTerm({ evidenceRefs: [kbEvidenceRef("1")] })],
          crossDependencies: [kbDependency({ evidenceRefs: [kbEvidenceRef("1")] })],
        }),
        knowledgeBase({
          modules: [kbModule({ id: "MOD_AUTH", description: "Manages user identities.", sourceWorkItemIds: ["2"], evidenceRefs: [kbEvidenceRef("2")] })],
          businessRules: [kbBusinessRule({ id: "BR_1", rule: "Retry limit is 5", sourceWorkItemIds: ["2"], evidenceRefs: [kbEvidenceRef("2")] })],
          stateTransitions: [kbStateTransition({ id: "TRANSITION_ORDER", toState: "Rejected", sourceWorkItemIds: ["2"], evidenceRefs: [kbEvidenceRef("2")] })],
          glossary: [kbGlossaryTerm({ term: "CUSTOMER", definition: "An account holder.", sourceWorkItemIds: ["2"], evidenceRefs: [kbEvidenceRef("2")] })],
          crossDependencies: [kbDependency({ id: "DEP_CHECKOUT_PAYMENT", targetModule: "Fraud", sourceWorkItemIds: ["2"], evidenceRefs: [kbEvidenceRef("2")] })],
        }),
      ],
    });

    expect(snapshot.knowledgeBase.modules).toHaveLength(2);
    expect(snapshot.knowledgeBase.businessRules).toHaveLength(2);
    expect(snapshot.knowledgeBase.stateTransitions).toHaveLength(2);
    expect(snapshot.knowledgeBase.glossary).toHaveLength(2);
    expect(snapshot.knowledgeBase.crossDependencies).toHaveLength(2);
    expect(snapshot.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "hard_conflict", conflictType: "duplicate_identity" }),
    ]));
    expect(snapshot.blockers.filter((blocker) =>
      "conflictType" in blocker && blocker.conflictType === "duplicate_identity",
    )).toHaveLength(3);
    expect(snapshot.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ conflictType: "incompatible_concrete_value" }),
      expect.objectContaining({ conflictType: "incompatible_transition_target" }),
    ]));
    expect(draftService.completeProjectKnowledgeDraft).toHaveBeenCalledWith(expect.objectContaining({
      metrics: expect.objectContaining({ automaticDuplicateConsolidationCount: 0 }),
    }));
  });

  it("consolidates normalization-equivalent duplicates in every knowledge category", async () => {
    setWorkItems([
      workItemRow({ azure_work_item_id: "1" }),
      workItemRow({ azure_work_item_id: "2" }),
    ]);

    const snapshot = await saveManualProjectKnowledgeBaseFromBatches({
      scope: projectScope(),
      actor: "qa",
      partialKnowledgeBases: [
        knowledgeBase({
          modules: [kbModule()],
          businessRules: [kbBusinessRule()],
          stateTransitions: [kbStateTransition()],
          glossary: [kbGlossaryTerm()],
          crossDependencies: [kbDependency()],
        }),
        knowledgeBase({
          modules: [kbModule({ id: "MOD_AUTH", name: " authentication ", description: " handles login. ", sourceWorkItemIds: ["2"], evidence: "Story 2" })],
          businessRules: [kbBusinessRule({ id: "BR_1", rule: " checkout requires payment. ", sourceField: "acceptance_criteria", sourceWorkItemIds: ["2"], evidence: "Story 2" })],
          stateTransitions: [kbStateTransition({ id: "TRANSITION_ORDER", workflowName: " order lifecycle ", fromState: " pending ", toState: " approved ", triggerOrCondition: " payment succeeds ", sourceWorkItemIds: ["2"], evidence: "Story 2" })],
          glossary: [kbGlossaryTerm({ term: " customer ", definition: " a person. ", sourceWorkItemIds: ["2"], evidence: "Story 2" })],
          crossDependencies: [kbDependency({ id: "DEP_CHECKOUT_PAYMENT", sourceModule: " checkout ", targetModule: " payment ", dependencyType: " uses ", description: " checkout uses payment. ", sourceWorkItemIds: ["2"], evidence: "Story 2" })],
        }),
      ],
    });

    expect(snapshot.knowledgeBase.modules).toHaveLength(1);
    expect(snapshot.knowledgeBase.businessRules).toHaveLength(1);
    expect(snapshot.knowledgeBase.stateTransitions).toHaveLength(1);
    expect(snapshot.knowledgeBase.glossary).toHaveLength(1);
    expect(snapshot.knowledgeBase.crossDependencies).toHaveLength(1);
    expect(draftService.completeProjectKnowledgeDraft).toHaveBeenCalledWith(expect.objectContaining({
      metrics: expect.objectContaining({ automaticDuplicateConsolidationCount: 5 }),
    }));
  });

  it("preserves punctuation-distinct glossary identities while consolidating Unicode separator aliases", async () => {
    setWorkItems([
      workItemRow({ azure_work_item_id: "1" }),
      workItemRow({ azure_work_item_id: "2" }),
    ]);

    const snapshot = await saveManualProjectKnowledgeBaseFromBatches({
      scope: projectScope(),
      actor: "qa",
      partialKnowledgeBases: [
        knowledgeBase({
          glossary: [
            kbGlossaryTerm({
              term: "C++",
              definition: "A programming language.",
              evidenceRefs: [kbEvidenceRef("1", "snapshot-language")],
            }),
            kbGlossaryTerm({
              term: "客户_地址",
              definition: "客户的配送地址。",
              evidenceRefs: [kbEvidenceRef("1")],
            }),
          ],
        }),
        knowledgeBase({
          glossary: [
            kbGlossaryTerm({
              term: "C#",
              definition: "A programming language.",
              evidenceRefs: [kbEvidenceRef("1", "snapshot-language")],
            }),
            kbGlossaryTerm({
              term: "客户 地址",
              definition: "客户的配送地址。",
              sourceWorkItemIds: ["2"],
              evidence: "Story 2",
              evidenceRefs: [kbEvidenceRef("2")],
            }),
          ],
        }),
      ],
    });

    expect(snapshot.knowledgeBase.glossary.map((term) => term.term)).toEqual([
      "C++",
      "客户_地址",
      "C#",
    ]);
    expect(snapshot.knowledgeBase.glossary[1].sourceWorkItemIds).toEqual(["1", "2"]);
    expect(draftService.completeProjectKnowledgeDraft).toHaveBeenCalledWith(expect.objectContaining({
      metrics: expect.objectContaining({ automaticDuplicateConsolidationCount: 1 }),
    }));
  });

  it("merges legacy evidence without unescaping backslashes", async () => {
    setWorkItems([
      workItemRow({ azure_work_item_id: "1" }),
      workItemRow({ azure_work_item_id: "2" }),
    ]);
    const uncQuote = String.raw`Use \\server\share\checkout.json`;
    const regexQuote = String.raw`Validate \d+\|\w+`;

    const snapshot = await saveManualProjectKnowledgeBaseFromBatches({
      scope: projectScope(),
      actor: "qa",
      partialKnowledgeBases: [
        knowledgeBase({ modules: [kbModule({ id: "mod-one", name: "Shared", evidence: uncQuote })] }),
        knowledgeBase({ modules: [kbModule({ id: "mod-two", name: "Shared", evidence: regexQuote, sourceWorkItemIds: ["2"] })] }),
      ],
    });

    expect(snapshot.knowledgeBase.modules).toHaveLength(1);
    expect(snapshot.knowledgeBase.modules[0].evidence).toBe(`${uncQuote} | ${regexQuote}`);
  });

  it("prunes affected and retired sources from the saved knowledge before merging incremental batches", async () => {
    setWorkItems([
      workItemRow({ azure_work_item_id: "1", content_hash: "h1" }),
      workItemRow({ azure_work_item_id: "2", content_hash: "h2-new" }),
    ]);
    stubExistingKnowledge({
      snapshot: snapshotRow(knowledgeBase({
        modules: [
          kbModule({ id: "mod-1", name: "Catalog", sourceWorkItemIds: ["1"], evidence: "Catalog story" }),
          kbModule({ id: "mod-2", name: "Checkout", sourceWorkItemIds: ["2"], evidence: "Old checkout story" }),
          kbModule({ id: "mod-3", name: "Reports", sourceWorkItemIds: ["1", "3"], evidence: "Reports story" }),
        ],
        businessRules: [kbBusinessRule({ id: "br-old", sourceWorkItemIds: ["3"], evidence: "Retired story" })],
      })),
      sourceWorkItemHashes: { "1": "h1", "2": "h2-old", "3": "h3" },
    });

    const snapshot = await saveManualProjectKnowledgeBaseFromBatches({
      scope: projectScope(),
      actor: "qa",
      partialKnowledgeBases: [knowledgeBase({
        modules: [kbModule({ id: "mod-2", name: "Checkout", description: "Updated checkout flow.", sourceWorkItemIds: ["2"], evidence: "New evidence" })],
      })],
      mode: "incremental",
    });

    // mod-1 untouched; mod-2 (changed source) replaced by the batch output; mod-3
    // keeps only its still-active unchanged source; the rule backed solely by the
    // retired item "3" is dropped.
    expect(snapshot.knowledgeBase.modules.map((module) => ({ id: module.id, sourceWorkItemIds: module.sourceWorkItemIds }))).toEqual([
      { id: "mod-1", sourceWorkItemIds: ["1"] },
      { id: "mod-3", sourceWorkItemIds: ["1"] },
      { id: "mod-2", sourceWorkItemIds: ["2"] },
    ]);
    expect(snapshot.knowledgeBase.modules[2].description).toBe("Updated checkout flow.");
    expect(snapshot.knowledgeBase.businessRules).toEqual([]);

    const rawOutput = JSON.parse(snapshot.rawOutput ?? "{}");
    expect(rawOutput.mode).toBe("incremental");
    expect(rawOutput.changedSourceWorkItemIds).toEqual(["2"]);
    expect(rawOutput.retiredSourceWorkItemIds).toEqual(["3"]);

    // Finalization persists a reviewable draft; publication owns revision writes.
    expect(draftService.completeProjectKnowledgeDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        draftId: "draft-1",
        touchedSourceWorkItemIds: ["2", "3"],
        knowledgeBase: snapshot.knowledgeBase,
      }),
    );
    expect(compiledService.recordProjectKnowledgeRevision).not.toHaveBeenCalled();
  });

  it("rejects a full-mode save with no validated batches before writing anything", async () => {
    setWorkItems([workItemRow()]);

    await expect(saveManualProjectKnowledgeBaseFromBatches({
      scope: projectScope(),
      actor: "qa",
      partialKnowledgeBases: [],
    })).rejects.toThrow("Validate at least one batch response before saving the knowledge base.");
    expect(database.withTransaction).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });
});

describe("same-evidence paraphrase handling", () => {
  it("carries previous wording through a full recompile when evidence content is unchanged", async () => {
    setWorkItems([workItemRow({ azure_work_item_id: "10", content_hash: "h10", current_snapshot_id: "snapshot-new-10" })]);
    const existing = knowledgeBase({
      glossary: [kbGlossaryTerm({
        term: "Discount",
        definition: "A price reduction applied by a valid promo code and included in order totals.",
        sourceWorkItemIds: ["10"],
        evidenceRefs: [kbEvidenceRef("10", "snapshot-old-10", "Valid code applies discount")],
      })],
    });
    stubExistingKnowledge({ snapshot: snapshotRow(existing) });
    const provider = fakeLlmProvider({
      structuredOutput: knowledgeBase({
        glossary: [kbGlossaryTerm({
          term: "Discount",
          definition: "A reduction applied by a valid promo code and included in order totals.",
          sourceWorkItemIds: ["10"],
          evidenceRefs: [kbEvidenceRef("10", "snapshot-new-10", "Valid code applies discount")],
        })],
      }),
    });

    const draft = await previewGeneratedProjectKnowledgeBase({
      scope: projectScope(),
      actor: "qa",
      provider,
      mode: "full",
    });

    expect(draft.wordingCarryOverCount).toBe(1);
    expect(draft.knowledgeBase.glossary[0]).toMatchObject({
      term: "Discount",
      definition: "A price reduction applied by a valid promo code and included in order totals.",
      evidenceRefs: [expect.objectContaining({ sourceSnapshotId: "snapshot-new-10" })],
    });
    expect(draftService.completeProjectKnowledgeDraft).toHaveBeenCalledWith(expect.objectContaining({
      metrics: expect.objectContaining({ wordingCarryOverCount: 1 }),
    }));
  });

  it("auto-merges same-evidence paraphrases across snapshot churn but keeps concrete disagreements", async () => {
    setWorkItems([workItemRow({ azure_work_item_id: "1", content_hash: "h1" })]);
    const partials = [
      knowledgeBase({
        businessRules: [
          kbBusinessRule({
            id: "br-reason",
            rule: "A reason is required.",
            evidenceRefs: [kbEvidenceRef("1", "snapshot-run-a", "reason is required")],
          }),
          kbBusinessRule({
            id: "br-retry",
            rule: "Maximum retry count is 3.",
            evidenceRefs: [kbEvidenceRef("1", "snapshot-run-a", "retry limit")],
          }),
        ],
        glossary: [kbGlossaryTerm({
          term: "Discount",
          definition: "A price reduction applied by a valid promo code.",
          evidenceRefs: [kbEvidenceRef("1", "snapshot-run-a", "Valid code applies discount")],
        })],
      }),
      knowledgeBase({
        businessRules: [
          kbBusinessRule({
            id: "br-reason",
            rule: "Providing a reason is required.",
            evidenceRefs: [kbEvidenceRef("1", "snapshot-run-b", "reason is required")],
          }),
          kbBusinessRule({
            id: "br-retry",
            rule: "Maximum retry count is 5.",
            evidenceRefs: [kbEvidenceRef("1", "snapshot-run-b", "retry limit")],
          }),
        ],
        glossary: [kbGlossaryTerm({
          term: "Discount",
          definition: "A reduction applied by a valid promo code.",
          evidenceRefs: [kbEvidenceRef("1", "snapshot-run-b", "Valid code applies discount")],
        })],
      }),
    ];

    const saved = await saveManualProjectKnowledgeBaseFromBatches({
      scope: projectScope(),
      actor: "qa",
      partialKnowledgeBases: partials,
      mode: "full",
    });

    // Paraphrases citing identical evidence content merge even though the snapshot
    // ids differ; the concrete "3 vs 5" disagreement must survive for conflict review.
    expect(saved.knowledgeBase.glossary).toHaveLength(1);
    const reasonRules = saved.knowledgeBase.businessRules.filter((rule) => rule.id === "br-reason");
    const retryRules = saved.knowledgeBase.businessRules.filter((rule) => rule.id === "br-retry");
    expect(reasonRules).toHaveLength(1);
    expect(reasonRules[0].evidenceRefs).toHaveLength(2);
    expect(retryRules).toHaveLength(2);
    expect(detectProjectKnowledgeHardConflicts(saved.knowledgeBase)).toEqual([
      expect.objectContaining({
        conflictType: "incompatible_concrete_value",
        evidenceIdentical: true,
      }),
    ]);
  });

  it("uses the parent draft's reviewed wording as the carry-over baseline for manual rebase children", async () => {
    setWorkItems([workItemRow({ azure_work_item_id: "10", content_hash: "h10", current_snapshot_id: "snapshot-new-10" })]);
    const publishedWording = "Published old wording of the discount definition.";
    const reviewedWording = "Reviewer-approved wording of the discount definition.";
    const sharedRef = (snapshotId: string) => kbEvidenceRef("10", snapshotId, "Valid code applies discount");
    stubExistingKnowledge({
      snapshot: snapshotRow(knowledgeBase({
        glossary: [kbGlossaryTerm({
          term: "Discount",
          definition: publishedWording,
          sourceWorkItemIds: ["10"],
          evidenceRefs: [sharedRef("snapshot-published-10")],
        })],
      })),
    });
    const parentProposal = knowledgeBase({
      glossary: [kbGlossaryTerm({
        term: "Discount",
        definition: reviewedWording,
        sourceWorkItemIds: ["10"],
        evidenceRefs: [sharedRef("snapshot-parent-10")],
      })],
    });
    const baseDraft = await draftService.beginProjectKnowledgeDraft({});
    draftService.loadProjectKnowledgeManualBatchResults.mockResolvedValue(null);
    draftService.getProjectKnowledgeDraft.mockImplementation(async ({ draftId }: { draftId: string }) =>
      draftId === "draft-parent"
        ? { id: "draft-parent", status: "ready_for_review", proposedKnowledge: parentProposal }
        : { id: "draft-child", status: "awaiting_input", parentDraftId: "draft-parent", sourceManifest: baseDraft.sourceManifest });

    const saved = await saveManualProjectKnowledgeBaseFromBatches({
      scope: projectScope(),
      actor: "qa",
      draftId: "draft-child",
      partialKnowledgeBases: [knowledgeBase({
        glossary: [kbGlossaryTerm({
          term: "Discount",
          definition: "A fresh model paraphrase of the discount definition.",
          sourceWorkItemIds: ["10"],
          evidenceRefs: [sharedRef("snapshot-new-10")],
        })],
      })],
      mode: "full",
    });

    expect(saved.knowledgeBase.glossary[0].definition).toBe(reviewedWording);
    expect(saved.knowledgeBase.glossary[0].evidenceRefs).toEqual([
      expect.objectContaining({ sourceSnapshotId: "snapshot-new-10" }),
    ]);
    expect(draftService.completeProjectKnowledgeDraft).toHaveBeenCalledWith(expect.objectContaining({
      metrics: expect.objectContaining({ wordingCarryOverCount: 1 }),
    }));
  });
});
