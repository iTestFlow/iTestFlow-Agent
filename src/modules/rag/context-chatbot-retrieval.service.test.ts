import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  createId: vi.fn(() => "id-1"),
  nowIso: vi.fn(() => "2026-07-06T00:00:00.000Z"),
  sqlAll: vi.fn<(sql: string, params?: Record<string, unknown>) => Promise<unknown[]>>(),
  sqlGet: vi.fn<(sql: string, params?: Record<string, unknown>) => Promise<unknown>>(),
  sqlRun: vi.fn<(sql: string, params?: Record<string, unknown>) => Promise<number>>(),
}));

vi.mock("@/modules/shared/infrastructure/database/db", () => db);

import {
  buildFtsQuery,
  limitContextEvidenceByWorkItem,
  retrieveContextChatbotEvidence,
} from "./context-chatbot-retrieval.service";
import { projectScope } from "@/test/factories";

describe("limitContextEvidenceByWorkItem", () => {
  it("preserves relevance order while capping repeated chunks per work item", () => {
    const items = [
      { workItemId: "100", chunk: 1 },
      { workItemId: "100", chunk: 2 },
      { workItemId: "100", chunk: 3 },
      { workItemId: "200", chunk: 1 },
      { workItemId: "300", chunk: 1 },
      { workItemId: "200", chunk: 2 },
      { workItemId: "400", chunk: 1 },
    ];

    expect(limitContextEvidenceByWorkItem(items, { limit: 5, maxChunksPerWorkItem: 2 })).toEqual([
      { workItemId: "100", chunk: 1 },
      { workItemId: "100", chunk: 2 },
      { workItemId: "200", chunk: 1 },
      { workItemId: "300", chunk: 1 },
      { workItemId: "200", chunk: 2 },
    ]);
  });
});

describe("buildFtsQuery", () => {
  it("strips punctuation, quotes, and tsquery operators down to alphanumeric prefix terms", () => {
    // Output is bound as a parameter into to_tsquery('simple', ...): operator
    // characters must act as separators, never survive into a term, or Postgres
    // rejects the query with a tsquery syntax error.
    expect(buildFtsQuery('How does the "login" flow work? (auth & session:*) | !reset <-> retry')).toBe(
      "how:* | does:* | the:* | login:* | flow:* | work:* | auth:* | session:* | reset:* | retry:*",
    );
  });

  it("keeps unicode letters and digits as lowercased tokens", () => {
    expect(buildFtsQuery("Café MENU étape id42")).toBe("café:* | menu:* | étape:* | id42:*");
  });

  it("drops terms of 2 or fewer characters and joins survivors with OR", () => {
    expect(buildFtsQuery("go to the app db ui")).toBe("the:* | app:*");
  });

  it("dedupes repeated terms and caps the query at 16 terms", () => {
    expect(buildFtsQuery("Login login LOGIN")).toBe("login:*");

    const terms = Array.from({ length: 20 }, (_, index) => `term${String(index).padStart(2, "0")}`);
    expect(buildFtsQuery(terms.join(" "))).toBe(
      terms.slice(0, 16).map((term) => `${term}:*`).join(" | "),
    );
  });

  it("returns an empty query for empty, whitespace-only, or operator-only input", () => {
    expect(buildFtsQuery("")).toBe("");
    expect(buildFtsQuery("   \t  ")).toBe("");
    expect(buildFtsQuery("?! &| :* ()")).toBe("");
    expect(buildFtsQuery("a of it")).toBe("");
  });
});

describe("retrieveContextChatbotEvidence", () => {
  const knowledgeRow = {
    entry_id: "pke-1",
    category: "module",
    entry_key: "checkout",
    title: "Checkout",
    content: "Module: Checkout",
    source_work_item_ids: "100, 200",
    evidence: "WI 100",
  };
  const knowledgeEvidence = {
    sourceType: "project_knowledge",
    sourceId: "KB:module:checkout",
    category: "module",
    entryKey: "checkout",
    title: "Checkout",
    content: "Module: Checkout",
    sourceWorkItemIds: ["100", "200"],
    evidence: "WI 100",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Zero index counts and no knowledge snapshot: ensureContextChatbotSearchIndexes
    // skips every refresh path, so only the retrieval queries hit sqlAll.
    db.sqlGet.mockResolvedValue(undefined);
    db.sqlAll.mockResolvedValue([]);
  });

  it("skips FTS entirely for whitespace-only queries and serves fallback knowledge", async () => {
    db.sqlAll.mockResolvedValue([knowledgeRow]);

    const result = await retrieveContextChatbotEvidence({ scope: projectScope(), query: "   " });

    expect(result).toEqual({ context: [], knowledge: [knowledgeEvidence] });
    // Only the fallback query runs; the no-query path keeps the full knowledge limit.
    expect(db.sqlAll).toHaveBeenCalledTimes(1);
    const [sql, params] = db.sqlAll.mock.calls[0];
    expect(sql).not.toContain("to_tsquery");
    expect(params).toMatchObject({
      limit: 10,
      projectId: "project-1",
      azureProjectId: "azure-project-1",
    });
  });

  it("falls back instead of throwing when the FTS queries error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    db.sqlAll.mockImplementation(async (sql) => {
      if (sql.includes("to_tsquery")) throw new Error("syntax error in tsquery");
      return [knowledgeRow];
    });

    const result = await retrieveContextChatbotEvidence({ scope: projectScope(), query: "login flow" });

    expect(result).toEqual({ context: [], knowledge: [knowledgeEvidence] });

    // The sanitized query is bound as a parameter, never interpolated into SQL text.
    const ftsCalls = db.sqlAll.mock.calls.filter(([sql]) => sql.includes("to_tsquery"));
    expect(ftsCalls).toHaveLength(2);
    for (const [, params] of ftsCalls) {
      expect(params).toMatchObject({ ftsQuery: "login:* | flow:*" });
    }

    // The error fallback caps knowledge at 4 even though the requested limit is 10.
    const fallbackCall = db.sqlAll.mock.calls.find(([sql]) => !sql.includes("to_tsquery"));
    expect(fallbackCall?.[1]).toMatchObject({ limit: 4 });
  });

  it("falls back to browse-order knowledge when FTS matches nothing", async () => {
    db.sqlAll.mockImplementation(async (sql) => (sql.includes("to_tsquery") ? [] : [knowledgeRow]));

    const result = await retrieveContextChatbotEvidence({
      scope: projectScope(),
      query: "login flow",
      knowledgeLimit: 2,
    });

    expect(result).toEqual({ context: [], knowledge: [knowledgeEvidence] });
    // Fallback limit is min(4, knowledgeLimit).
    const fallbackCall = db.sqlAll.mock.calls.find(([sql]) => !sql.includes("to_tsquery"));
    expect(fallbackCall?.[1]).toMatchObject({ limit: 2 });
  });

  it("does not run the fallback when FTS returns matches", async () => {
    const chunkRow = {
      chunk_id: "chunk-1",
      azure_work_item_id: "100",
      work_item_type: "User Story",
      title: "Login",
      content: "Login flow details",
      metadata_json: JSON.stringify({ chunkIndex: 0 }),
    };
    db.sqlAll.mockImplementation(async (sql) => {
      if (sql.includes("document_chunks_fts")) return [chunkRow];
      if (sql.includes("project_knowledge_entries_fts")) return [knowledgeRow];
      return [{ ...knowledgeRow, entry_key: "unexpected-fallback" }];
    });

    const result = await retrieveContextChatbotEvidence({ scope: projectScope(), query: "login" });

    expect(result.context).toEqual([
      {
        sourceType: "project_context",
        sourceId: "WI:100",
        workItemId: "100",
        workItemType: "User Story",
        title: "Login",
        content: "Login flow details",
        metadata: { chunkIndex: 0 },
      },
    ]);
    expect(result.knowledge).toEqual([knowledgeEvidence]);
    expect(db.sqlAll).toHaveBeenCalledTimes(2);
  });
});
