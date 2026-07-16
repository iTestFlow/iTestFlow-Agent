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
import { PROJECT_KNOWLEDGE_COMPILER_CONTRACT_VERSION } from "./project-knowledge-contracts";
import { detectProjectKnowledgeHardConflicts } from "./project-knowledge-conflicts";
import { projectKnowledgeCitationHandle } from "./project-knowledge-grounding";
import {
  buildProjectKnowledgeManualDraft,
  loadProjectKnowledgeContext,
  previewGeneratedProjectKnowledgeBase,
  saveManualProjectKnowledgeBaseFromBatches,
  validateProjectKnowledgeExternalOutput,
  validateProjectKnowledgeManualBatch,
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
    compiler_contract_version: PROJECT_KNOWLEDGE_COMPILER_CONTRACT_VERSION,
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

describe("validateProjectKnowledgeManualBatch", () => {
  it("keeps a quote-backed structured constraint from pasted external output", async () => {
    setWorkItems([workItemRow({ acceptance_criteria: "Payment is required." })]);
    const acceptanceHandle = projectKnowledgeCitationHandle("snapshot-1", "acceptanceCriteria");
    const rawOutput = `External response:\n\n\`\`\`json\n${JSON.stringify({
      modules: [],
      businessRules: [{
        id: "br-payment-required",
        rule: "Payment is required.",
        moduleAssociations: ["Checkout", "Payments"],
        constraint: {
          object: "payment",
          property: "required",
          operator: "eq",
          value: "required",
          valueType: "boolean",
        },
        citations: [{ handle: acceptanceHandle, quote: "Payment is required." }],
      }],
      stateTransitions: [],
      glossary: [],
      crossDependencies: [],
    })}\n\`\`\``;

    const knowledgeBase = await validateProjectKnowledgeManualBatch({
      scope: projectScope(),
      draftId: "draft-1",
      batchIndex: 1,
      rawOutput,
    });

    expect(knowledgeBase.businessRules[0]).toMatchObject({
      id: "br-payment-required",
      moduleAssociations: ["Checkout", "Payments"],
      constraint: {
        object: "payment",
        property: "required",
        operator: "eq",
        value: "true",
        valueType: "boolean",
      },
    });
    expect(draftService.saveProjectKnowledgeManualBatchResult).toHaveBeenCalledWith(expect.objectContaining({
      draftId: "draft-1",
      batchIndex: 1,
      validatedOutput: knowledgeBase,
    }));
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
    // HTML is stripped, tags normalized, and immutable/internal IDs never reach the prompt.
    expect(userPrompt.sources).toEqual([{
      sourceGroup: "source_1",
      workItemType: "User Story",
      citationSources: [
        { handle: projectKnowledgeCitationHandle("snapshot-1", "title"), sourceField: "title", text: "Customer checks out" },
        { handle: projectKnowledgeCitationHandle("snapshot-1", "description"), sourceField: "description", text: "Allow checkout" },
        { handle: projectKnowledgeCitationHandle("snapshot-1", "acceptanceCriteria"), sourceField: "acceptanceCriteria", text: "Given cart" },
        { handle: projectKnowledgeCitationHandle("snapshot-1", "state"), sourceField: "state", text: "Active" },
        { handle: projectKnowledgeCitationHandle("snapshot-1", "tags"), sourceField: "tags", text: "checkout; payments" },
      ],
    }]);
    expect(draft.batches[0].userPrompt).not.toContain("snapshot-1");
    expect(draft.batches[0].userPrompt).not.toContain('"id": "1"');
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
    expect(firstBatch.sources.map((item: { sourceGroup: string }) => item.sourceGroup)).toEqual(["source_1", "source_2"]);
    expect(secondBatch.sources.map((item: { sourceGroup: string }) => item.sourceGroup)).toEqual(["source_1"]);
    expect(firstBatch.sources.map((item: { citationSources: Array<{ text: string }> }) => item.citationSources[0].text)).toEqual(["Item 1", "Item 2"]);
    expect(secondBatch.sources[0].citationSources[0].text).toBe("Item 3");
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

  it("falls back to a full compile when the saved compiler contract is outdated", async () => {
    setWorkItems([
      workItemRow({ azure_work_item_id: "1", content_hash: "h1" }),
      workItemRow({ azure_work_item_id: "2", content_hash: "h2" }),
    ]);
    stubExistingKnowledge({
      snapshot: snapshotRow(
        knowledgeBase({ modules: [kbModule()] }),
        { compiler_contract_version: "4.0.0" },
      ),
      sourceWorkItemHashes: { "1": "h1", "2": "h2" },
    });

    const draft = await buildProjectKnowledgeManualDraft({ scope: projectScope(), mode: "incremental" });

    expect(draft.requestedMode).toBe("incremental");
    expect(draft.mode).toBe("full");
    expect(draft.fallbackReason).toContain("compiler contract changed");
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
    expect(userPrompt.sources.map((item: { citationSources: Array<{ text: string }> }) => item.citationSources[0].text)).toEqual(["Changed item"]);
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
    expect(userPrompt.sources.map((item: { sourceGroup: string }) => item.sourceGroup)).toEqual(["source_1"]);
    expect(userPrompt.sources[0].citationSources[0].text).toBe("Customer checks out");
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

describe("automatic v4 reconciliation prompts", () => {
  it("consolidates duplicates produced inside one automatic extraction batch", async () => {
    setWorkItems([workItemRow({ azure_work_item_id: "1", content_hash: "h1" })]);
    const provider = fakeLlmProvider({
      structuredOutput: {
        modules: [
          {
            id: "mod-auth",
            name: "Authentication",
            description: "Handles login.",
            citations: [{
              handle: projectKnowledgeCitationHandle("snapshot-1", "title"),
              quote: "Customer checks out",
            }],
          },
          {
            id: "MOD_AUTH",
            name: " authentication ",
            description: " handles login. ",
            citations: [{
              handle: projectKnowledgeCitationHandle("snapshot-1", "state"),
              quote: "Active",
            }],
          },
        ],
        businessRules: [],
        stateTransitions: [],
        glossary: [],
        crossDependencies: [],
      },
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
      evidence: "Active | Customer checks out",
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

  it("merges compatible descriptions from different sources while preserving structured conflicts", async () => {
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

    expect(snapshot.knowledgeBase.modules).toHaveLength(1);
    expect(snapshot.knowledgeBase.businessRules).toHaveLength(2);
    expect(snapshot.knowledgeBase.stateTransitions).toHaveLength(2);
    expect(snapshot.knowledgeBase.glossary).toHaveLength(1);
    expect(snapshot.knowledgeBase.crossDependencies).toHaveLength(2);
    expect(snapshot.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        conflictType: "incompatible_concrete_value",
        conflictBasis: expect.objectContaining({
          object: "retry",
          property: "limit",
          values: expect.arrayContaining([
            expect.objectContaining({ operator: "eq", value: "3", valueType: "number" }),
            expect.objectContaining({ operator: "eq", value: "5", valueType: "number" }),
          ]),
        }),
      }),
      expect.objectContaining({ conflictType: "incompatible_transition_target" }),
    ]));
    expect(snapshot.blockers).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ conflictType: "duplicate_identity" }),
    ]));
    expect(draftService.completeProjectKnowledgeDraft).toHaveBeenCalledWith(expect.objectContaining({
      metrics: expect.objectContaining({ automaticDuplicateConsolidationCount: 2 }),
    }));
  });

  it("auto-merges broad and narrow glossary definitions and retains every source", async () => {
    setWorkItems([
      workItemRow({ azure_work_item_id: "1" }),
      workItemRow({ azure_work_item_id: "2" }),
    ]);
    const glossary = (sourceWorkItemId: string, entries: Array<[string, string]>) => entries.map(([term, definition]) => ({
      term,
      type: "business_entity" as const,
      definition,
      sourceWorkItemIds: [sourceWorkItemId],
      evidence: `${term} evidence from ${sourceWorkItemId}`,
      evidenceRefs: [kbEvidenceRef(
        sourceWorkItemId,
        `snapshot-${sourceWorkItemId}`,
        `${term} evidence from ${sourceWorkItemId}`,
      )],
    }));

    const result = await saveManualProjectKnowledgeBaseFromBatches({
      scope: projectScope(),
      actor: "qa",
      partialKnowledgeBases: [
        knowledgeBase({ glossary: glossary("1", [
          ["Customer", "A customer can discover products, purchase securely, manage orders, and use ecommerce features such as checkout, cart, catalog browsing, order history, and returns/refunds."],
          ["Order", "A purchase record created after successful payment, shown in order history with date, status, total, and items, and tracked through defined statuses."],
          ["Cart", "A collection of products a customer can add to, update, or remove from before purchase."],
        ]) }),
        knowledgeBase({ glossary: glossary("2", [
          ["Customer", "A user who discovers products, purchases them securely, and manages orders after checkout."],
          ["Order", "A purchase record created by successful payment and viewable in order history and status tracking."],
          ["Cart", "A place where customers add products, update quantities, remove items, apply discounts, and see totals."],
        ]) }),
      ],
    });

    expect(result.knowledgeBase.glossary).toHaveLength(3);
    expect(result.knowledgeBase.glossary).toEqual(expect.arrayContaining([
      expect.objectContaining({
        term: "Customer",
        definition: expect.stringContaining("returns/refunds"),
        sourceWorkItemIds: ["1", "2"],
        evidenceRefs: expect.arrayContaining([
          expect.objectContaining({ sourceWorkItemId: "1" }),
          expect.objectContaining({ sourceWorkItemId: "2" }),
        ]),
      }),
      expect.objectContaining({
        term: "Order",
        definition: expect.stringContaining("date, status, total, and items"),
        sourceWorkItemIds: ["1", "2"],
      }),
      expect.objectContaining({
        term: "Cart",
        definition: expect.stringContaining("apply discounts"),
        sourceWorkItemIds: ["1", "2"],
      }),
    ]));
    expect(detectProjectKnowledgeHardConflicts(result.knowledgeBase)).toEqual([]);
    expect(draftService.completeProjectKnowledgeDraft).toHaveBeenCalledWith(expect.objectContaining({
      metrics: expect.objectContaining({ automaticDuplicateConsolidationCount: 3 }),
    }));
  });

  it("auto-merges synonymous dependency types backed by the same immutable evidence", async () => {
    setWorkItems([workItemRow({ azure_work_item_id: "15" })]);
    const quote = "Payment gateway is called; successful payment creates order; confirmation page and email are generated.";
    const evidenceRefs = [kbEvidenceRef("15", "snapshot-15", quote)];

    const result = await saveManualProjectKnowledgeBaseFromBatches({
      scope: projectScope(),
      actor: "qa",
      partialKnowledgeBases: [
        knowledgeBase({
          crossDependencies: [kbDependency({
            id: "checkout-payment-service-dependency",
            sourceModule: "Checkout",
            targetModule: "Payment Gateway",
            dependencyType: "external service call",
            description: "Checkout calls the payment gateway.",
            sourceWorkItemIds: ["15"],
            evidence: quote,
            evidenceRefs,
          })],
        }),
        knowledgeBase({
          crossDependencies: [kbDependency({
            id: "Dep Checkout Payment Gateway",
            sourceModule: "Checkout",
            targetModule: "Payment Gateway",
            dependencyType: "external service dependency",
            description: "Checkout depends on the payment gateway.",
            sourceWorkItemIds: ["15"],
            evidence: quote,
            evidenceRefs,
          })],
        }),
      ],
    });

    expect(result.knowledgeBase.crossDependencies).toEqual([
      expect.objectContaining({
        dependencyType: "external service dependency",
        sourceWorkItemIds: ["15"],
        evidenceRefs: [expect.objectContaining({
          sourceSnapshotId: "snapshot-15",
          sourceWorkItemId: "15",
          quote,
        })],
      }),
    ]);
    expect(detectProjectKnowledgeHardConflicts(result.knowledgeBase)).toEqual([]);
    expect(draftService.completeProjectKnowledgeDraft).toHaveBeenCalledWith(expect.objectContaining({
      metrics: expect.objectContaining({ automaticDuplicateConsolidationCount: 1 }),
    }));
  });

  it("does not bridge incompatible dependency transports through a generic dependency", async () => {
    setWorkItems([workItemRow({ azure_work_item_id: "15" })]);
    const quote = "Checkout communicates with the payment service.";
    const evidenceRefs = [kbEvidenceRef("15", "snapshot-15", quote)];
    const dependency = (dependencyType: string) => kbDependency({
      id: "dep-checkout-payment",
      sourceModule: "Checkout",
      targetModule: "Payment Service",
      dependencyType,
      description: "Checkout communicates with the payment service.",
      sourceWorkItemIds: ["15"],
      evidence: quote,
      evidenceRefs,
    });

    const result = await saveManualProjectKnowledgeBaseFromBatches({
      scope: projectScope(),
      actor: "qa",
      partialKnowledgeBases: [
        knowledgeBase({ crossDependencies: [dependency("event")] }),
        knowledgeBase({ crossDependencies: [dependency("dependency")] }),
        knowledgeBase({ crossDependencies: [dependency("api")] }),
      ],
    });

    expect(result.knowledgeBase.crossDependencies).toHaveLength(2);
    expect(result.knowledgeBase.crossDependencies.map((entry) => entry.dependencyType).sort())
      .toEqual(["api dependency", "event dependency"]);
  });

  it("always applies business-constraint and dependency-evidence compatibility gates", async () => {
    setWorkItems([workItemRow({ azure_work_item_id: "16" })]);
    const sharedRule = "Retry limit must be configured.";
    const dependencyDescription = "Checkout calls the payment service.";
    const partial = (constraintValue: string, dependencyQuote: string) => knowledgeBase({
      businessRules: [kbBusinessRule({
        id: "br-retry",
        rule: sharedRule,
        constraint: {
          object: "retry",
          property: "limit",
          operator: "eq",
          value: constraintValue,
          valueType: "number",
        },
        sourceWorkItemIds: ["16"],
        evidence: sharedRule,
        evidenceRefs: [kbEvidenceRef("16", `snapshot-rule-${constraintValue}`, sharedRule)],
      })],
      crossDependencies: [kbDependency({
        id: "dep-checkout-payment",
        sourceModule: "Checkout",
        targetModule: "Payment Service",
        dependencyType: "api",
        description: dependencyDescription,
        sourceWorkItemIds: ["16"],
        evidence: dependencyQuote,
        evidenceRefs: [kbEvidenceRef("16", `snapshot-dependency-${constraintValue}`, dependencyQuote)],
      })],
    });

    const result = await saveManualProjectKnowledgeBaseFromBatches({
      scope: projectScope(),
      actor: "qa",
      partialKnowledgeBases: [
        partial("3", "Checkout calls the first payment endpoint."),
        partial("5", "Checkout calls the second payment endpoint."),
      ],
    });

    expect(result.knowledgeBase.businessRules).toHaveLength(2);
    expect(result.knowledgeBase.crossDependencies).toHaveLength(2);
  });

  it("does not merge normalization-equivalent dependencies when their evidence differs", async () => {
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
    expect(snapshot.knowledgeBase.crossDependencies).toHaveLength(2);
    expect(draftService.completeProjectKnowledgeDraft).toHaveBeenCalledWith(expect.objectContaining({
      metrics: expect.objectContaining({ automaticDuplicateConsolidationCount: 4 }),
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
    setWorkItems([workItemRow({
      azure_work_item_id: "10",
      content_hash: "h10",
      current_snapshot_id: "snapshot-new-10",
      description: "Valid code applies discount",
    })]);
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
      structuredOutput: {
        modules: [],
        businessRules: [],
        stateTransitions: [],
        glossary: [{
          term: "Discount",
          type: "term",
          definition: "A reduction applied by a valid promo code and included in order totals.",
          citations: [{
            handle: projectKnowledgeCitationHandle("snapshot-new-10", "description"),
            quote: "Valid code applies discount",
          }],
        }],
        crossDependencies: [],
      },
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
            rule: "Retry count is 3.",
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
            rule: "The reason is required.",
            evidenceRefs: [kbEvidenceRef("1", "snapshot-run-b", "reason is required")],
          }),
          kbBusinessRule({
            id: "br-retry",
            rule: "Retry count is 5.",
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

});
