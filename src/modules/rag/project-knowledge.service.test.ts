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

vi.mock("@/modules/shared/infrastructure/database/db", () => database);
vi.mock("@/modules/audit/audit.service", () => ({ writeAuditLog }));
vi.mock("@/modules/rag/project-knowledge-compiled.service", () => compiledService);
vi.mock("@/modules/rag/context-chatbot-retrieval.service", () => ({ refreshProjectKnowledgeSearchIndex }));
vi.mock("@/modules/rag/project-context-schema.service", () => ({ ensureProjectContextSyncSchema: vi.fn() }));

import { projectKnowledgeExtractionPrompt } from "@/modules/llm/prompts";
import { AppError, AppErrorCode } from "@/modules/shared/errors/app-error";
import { projectScope } from "@/test/factories";
import type { ProjectKnowledgeBase } from "./project-knowledge.schema";
import {
  buildProjectKnowledgeManualDraft,
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
    ...overrides,
  };
}

type KnowledgeModule = ProjectKnowledgeBase["modules"][number];
type KnowledgeBusinessRule = ProjectKnowledgeBase["businessRules"][number];
type KnowledgeGlossaryTerm = ProjectKnowledgeBase["glossary"][number];

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
    database.sqlAll.mockResolvedValue([workItemRow({
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
    database.sqlAll.mockResolvedValue([1, 2, 3].map((id) => workItemRow({
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
    database.sqlAll.mockResolvedValue([
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
  it("prompts every work item in full mode without consulting saved snapshots", async () => {
    database.sqlAll.mockResolvedValue([
      workItemRow({ azure_work_item_id: "1" }),
      workItemRow({ azure_work_item_id: "2" }),
    ]);

    const draft = await buildProjectKnowledgeManualDraft({ scope: projectScope(), mode: "full" });

    expect(draft.mode).toBe("full");
    expect(draft.sourceWorkItemCount).toBe(2);
    expect(draft.changedSourceWorkItemCount).toBe(2);
    expect(draft.retiredSourceWorkItemCount).toBe(0);
    expect(database.sqlGet).not.toHaveBeenCalled();
  });

  it("falls back to a full compile when no knowledge base is saved yet", async () => {
    database.sqlAll.mockResolvedValue([
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
    database.sqlAll.mockResolvedValue([
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
    expect(userPrompt.incrementalInstruction).toContain("only from the provided changed workItems");
  });

  it("uses the snapshot timestamp as baseline when the saved revision has no source hashes", async () => {
    database.sqlAll.mockResolvedValue([
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

describe("saveManualProjectKnowledgeBaseFromBatches", () => {
  it("deduplicates items across batches by id, name, rule text, and glossary term", async () => {
    database.sqlAll.mockResolvedValue([
      workItemRow({ azure_work_item_id: "1" }),
      workItemRow({ azure_work_item_id: "2" }),
    ]);
    const batchOne = knowledgeBase({
      modules: [kbModule()],
      businessRules: [kbBusinessRule()],
      glossary: [kbGlossaryTerm()],
    });
    const batchTwo = knowledgeBase({
      modules: [
        // "MOD_AUTH" normalizes to the same key as "mod-auth".
        kbModule({ id: "MOD_AUTH", description: "Handles login and sessions.", sourceWorkItemIds: ["2"], evidence: "Session story" }),
        kbModule({ id: "mod-pay", name: "Payments", description: "Handles payments.", sourceWorkItemIds: ["2"], evidence: "Payment story" }),
      ],
      businessRules: [kbBusinessRule({ id: "br-2", sourceField: "description", sourceWorkItemIds: ["2"], evidence: "Description on story 2" })],
      glossary: [kbGlossaryTerm({ type: "business_entity", definition: "A person who buys products.", sourceWorkItemIds: ["2"], evidence: "Story 2" })],
    });

    const snapshot = await saveManualProjectKnowledgeBaseFromBatches({
      scope: projectScope(),
      actor: "qa",
      partialKnowledgeBases: [batchOne, batchTwo],
    });

    // Merged duplicates keep the longer text, union sources, and concatenate evidence.
    expect(snapshot.knowledgeBase.modules).toEqual([
      {
        id: "mod-auth",
        name: "Authentication",
        description: "Handles login and sessions.",
        sourceWorkItemIds: ["1", "2"],
        evidence: "Login story | Session story",
      },
      {
        id: "mod-pay",
        name: "Payments",
        description: "Handles payments.",
        sourceWorkItemIds: ["2"],
        evidence: "Payment story",
      },
    ]);
    // Same rule text merges even under different ids; the first id wins.
    expect(snapshot.knowledgeBase.businessRules).toEqual([expect.objectContaining({
      id: "br-1",
      rule: "Checkout requires payment.",
      sourceWorkItemIds: ["1", "2"],
      evidence: "AC on story 1 | Description on story 2",
    })]);
    // Glossary duplicates keep the more business-like type.
    expect(snapshot.knowledgeBase.glossary).toEqual([expect.objectContaining({
      term: "Customer",
      type: "business_entity",
      definition: "A person who buys products.",
      sourceWorkItemIds: ["1", "2"],
    })]);

    const rawOutput = JSON.parse(snapshot.rawOutput ?? "{}");
    expect(rawOutput.consolidationMode).toBe("local-deterministic");
    expect(rawOutput.mode).toBe("full");
    expect(writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: "rag.extract_project_knowledge_base.manual_batch_complete",
      status: "Success",
      details: expect.objectContaining({ mode: "full", batchCount: 2 }),
    }));
  });

  it("prunes affected and retired sources from the saved knowledge before merging incremental batches", async () => {
    database.sqlAll.mockResolvedValue([
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

    // The recorded revision carries the CURRENT hashes as the next incremental baseline.
    expect(compiledService.recordProjectKnowledgeRevision).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "incremental",
        sourceChangeSummary: expect.objectContaining({
          sourceWorkItemHashes: { "1": "h1", "2": "h2-new" },
          changedSourceWorkItemIds: ["2"],
          retiredSourceWorkItemIds: ["3"],
        }),
      }),
      expect.anything(),
    );
  });

  it("rejects a full-mode save with no validated batches before writing anything", async () => {
    database.sqlAll.mockResolvedValue([workItemRow()]);

    await expect(saveManualProjectKnowledgeBaseFromBatches({
      scope: projectScope(),
      actor: "qa",
      partialKnowledgeBases: [],
    })).rejects.toThrow("Validate at least one batch response before saving the knowledge base.");
    expect(database.withTransaction).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });
});
