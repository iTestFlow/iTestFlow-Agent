import { afterAll, beforeAll, expect, it } from "vitest";

import { flushBackgroundWrites, getPool, resetDatabaseForTests, sqlAll, sqlRun } from "@/modules/shared/infrastructure/database/db";
import {
  refreshProjectKnowledgeSearchIndex,
  retrieveContextChatbotEvidence,
} from "@/modules/rag/context-chatbot-retrieval.service";
import {
  chatInsightEntryKey,
  chatInsightLockKey,
  integrateProjectKnowledgeCandidate,
  promoteContextChatbotAnswer,
  rejectProjectKnowledgeCandidate,
} from "@/modules/rag/project-knowledge-compiled.service";
import { loadProjectKnowledgeContext } from "@/modules/rag/project-knowledge.service";
import { ProjectKnowledgeBaseSchema, type ProjectKnowledgeBase } from "@/modules/rag/project-knowledge.schema";
import { buildRequirementAnalysisMarkdownPrompt } from "@/modules/llm/markdown-prompt-renderer";
import type { ProjectScope } from "@/modules/projects/project-isolation.guard";
import { cleanupFixtures, describeDb, seedProject, seedWorkspace, uniqueTestId } from "@/test/db";

/**
 * An answer an admin saves from the Business Owner Assistant has to come back as
 * evidence for a later question, or the save button is decoration.
 *
 * Before this, three separate gates each blocked that independently: a promoted answer
 * was stored ungrounded and could never become grounded (grounding needs every fragment
 * to re-anchor to an immutable snapshot quote, and a synthesis across several work items
 * is not a quote from any of them), the integration action required the grounded state it
 * could never reach, and nothing consumed the resulting status anyway.
 */

const WS = uniqueTestId("ws_chatinsight");
const ORG = `https://dev.azure.com/${WS}`;
const PROJ = uniqueTestId("az_chatinsight");

const scope: ProjectScope = {
  projectId: PROJ,
  azureProjectId: PROJ,
  azureProjectName: "Chat Insight",
  azureOrganizationUrl: ORG,
};

// Wording chosen so the assertion below cannot pass on the compiled entry instead.
const INSIGHT = "Refund approvals above the daily ceiling escalate to a regional finance manager.";

function compiledKnowledge(): ProjectKnowledgeBase {
  return ProjectKnowledgeBaseSchema.parse({
    modules: [{
      id: "billing-module",
      name: "Billing",
      description: "Handles invoicing and refunds.",
      sourceWorkItemIds: ["8001"],
      evidence: "WI 8001",
    }],
    businessRules: [],
    stateTransitions: [],
    glossary: [],
    crossDependencies: [],
  });
}

/**
 * Entries are keyed by content, so tests that must not interfere have to use distinct
 * answers — otherwise one test's integrated candidate legitimately keeps another test's
 * entry alive, and the isolation failure looks like a product bug.
 */
async function savedAnswer(answer: string = INSIGHT) {
  return promoteContextChatbotAnswer({
    scope,
    actor: "admin-1",
    answer,
    citations: [{ sourceType: "project_context", sourceId: "WI:8001", workItemId: "8001" }],
  });
}

describeDb("saved chatbot answers reach retrieval (DB-backed)", () => {
  beforeAll(async () => {
    await seedWorkspace({ id: WS, orgUrl: ORG });
    await seedProject({ workspaceId: WS, orgUrl: ORG, azureProjectId: PROJ, azureProjectName: "Chat Insight" });
    await refreshProjectKnowledgeSearchIndex({
      scope,
      knowledgeBaseId: uniqueTestId("pkb"),
      knowledgeBase: compiledKnowledge(),
    });
  });

  afterAll(async () => {
    await flushBackgroundWrites();
    for (const table of [
      "embeddings",
      "project_knowledge_entries_fts",
      "project_knowledge_entries",
      "project_knowledge_candidates",
      "project_knowledge_log",
    ]) {
      await sqlRun(`DELETE FROM ${table} WHERE project_id = @p`, { p: PROJ });
    }
    await cleanupFixtures({ workspaceIds: [WS], userIds: [] });
    await resetDatabaseForTests();
  });

  it("a saved answer is not retrievable until it is integrated", async () => {
    await savedAnswer();

    const evidence = await retrieveContextChatbotEvidence({
      scope,
      query: "refund approvals regional finance manager",
      embeddingProvider: null,
      rerankProvider: null,
    });

    expect(evidence.knowledge.map((item) => item.content)).not.toContain(INSIGHT);
  });

  it("becomes retrievable once integrated, despite never being grounded", async () => {
    const candidate = await savedAnswer();
    // The state the old gate demanded, which this content can never reach.
    expect(candidate.status).toBe("legacy_ungrounded");

    const integrated = await integrateProjectKnowledgeCandidate({
      scope,
      candidateId: candidate.candidateId,
      actor: "admin-1",
    });
    expect(integrated?.status).toBe("integrated");

    const evidence = await retrieveContextChatbotEvidence({
      scope,
      query: "refund approvals regional finance manager",
      embeddingProvider: null,
      rerankProvider: null,
    });

    expect(evidence.knowledge.map((item) => item.content)).toContain(INSIGHT);
  });

  it("survives a knowledge republish, which rebuilds every compiled entry", async () => {
    // The republish path deletes and re-inserts the whole compiled set. An approved
    // insight is not in that set, so without an explicit guard publishing any draft
    // would silently discard it.
    const candidate = await savedAnswer();
    await integrateProjectKnowledgeCandidate({ scope, candidateId: candidate.candidateId, actor: "admin-1" });

    await refreshProjectKnowledgeSearchIndex({
      scope,
      knowledgeBaseId: uniqueTestId("pkb"),
      knowledgeBase: compiledKnowledge(),
    });

    const evidence = await retrieveContextChatbotEvidence({
      scope,
      query: "refund approvals regional finance manager",
      embeddingProvider: null,
      rerankProvider: null,
    });

    expect(evidence.knowledge.map((item) => item.content)).toContain(INSIGHT);
    // ...and the compiled entry is still there, so preserving one did not strand the other.
    const compiledEvidence = await retrieveContextChatbotEvidence({
      scope,
      query: "billing invoicing refunds",
      embeddingProvider: null,
      rerankProvider: null,
    });
    expect(compiledEvidence.knowledge.map((item) => item.entryKey)).toContain("billing-module");
  });

  it("integrating twice replaces the entry instead of duplicating it", async () => {
    const candidate = await savedAnswer();
    await integrateProjectKnowledgeCandidate({ scope, candidateId: candidate.candidateId, actor: "admin-1" });
    await integrateProjectKnowledgeCandidate({ scope, candidateId: candidate.candidateId, actor: "admin-2" });

    const evidence = await retrieveContextChatbotEvidence({
      scope,
      query: "refund approvals regional finance manager",
      embeddingProvider: null,
      rerankProvider: null,
    });

    expect(evidence.knowledge.filter((item) => item.content === INSIGHT)).toHaveLength(1);
  });

  it("records the insight as human-approved rather than verified", async () => {
    // The provenance distinction is the reason this is a separate category at all: an
    // accepted synthesis must not be indistinguishable from an extracted, re-anchorable
    // fact.
    const candidate = await savedAnswer();
    await integrateProjectKnowledgeCandidate({ scope, candidateId: candidate.candidateId, actor: "admin-1" });

    const evidence = await retrieveContextChatbotEvidence({
      scope,
      query: "refund approvals regional finance manager",
      embeddingProvider: null,
      rerankProvider: null,
    });
    const insight = evidence.knowledge.find((item) => item.content === INSIGHT);

    expect(insight?.category).toBe("chat_insight");
    expect(insight?.evidence).toContain("Approved from a Business Owner Assistant answer");
  });

  it("rejecting an integrated insight stops it being answerable", async () => {
    // Rejection was cosmetic: it flipped the status but left the indexed rows in place,
    // so content an admin explicitly rejected kept coming back as evidence forever.
    const answer = "Chargeback disputes older than ninety days route to the arbitration desk.";
    const candidate = await savedAnswer(answer);
    await integrateProjectKnowledgeCandidate({ scope, candidateId: candidate.candidateId, actor: "admin-1" });

    const before = await retrieveContextChatbotEvidence({
      scope, query: "chargeback disputes arbitration desk",
      embeddingProvider: null, rerankProvider: null,
    });
    expect(before.knowledge.map((item) => item.content)).toContain(answer);

    await rejectProjectKnowledgeCandidate({
      scope, candidateId: candidate.candidateId, actor: "admin-1", reason: "wrong",
    });

    const after = await retrieveContextChatbotEvidence({
      scope, query: "chargeback disputes arbitration desk",
      embeddingProvider: null, rerankProvider: null,
    });
    expect(after.knowledge.map((item) => item.content)).not.toContain(answer);
  });

  it("a reject that races a concurrent integrate still deindexes, even though the integrate commits first", async () => {
    // Reproduces the exact race the fix closes. rejectProjectKnowledgeCandidate used to
    // decide whether to deindex using a status read *before* its own transaction started.
    // If a concurrent integrate committed in the window between that read and this
    // function's own update, the read was stale: rejection flipped the status but the
    // insight it should have pulled stayed fully answerable. Holding the row lock
    // ourselves and queuing integrate then reject behind it forces exactly that
    // interleaving -- integrate commits first, reject's own read of the row must happen
    // only after that commit, not before it -- deterministically instead of by luck.
    const answer = "Refund holds beyond thirty days require a director's written sign-off.";
    const candidate = await savedAnswer(answer);

    const lockClient = await getPool().connect();
    try {
      await lockClient.query("BEGIN");
      await lockClient.query(
        "SELECT id FROM project_knowledge_candidates WHERE id = $1 FOR UPDATE",
        [candidate.candidateId],
      );

      const integratePromise = integrateProjectKnowledgeCandidate({
        scope, candidateId: candidate.candidateId, actor: "admin-1",
      });
      // Give integrate's own update time to reach Postgres and join the lock wait queue
      // before reject's does, so release below grants the lock to integrate first.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const rejectPromise = rejectProjectKnowledgeCandidate({
        scope, candidateId: candidate.candidateId, actor: "admin-2", reason: "changed my mind",
      });
      await new Promise((resolve) => setTimeout(resolve, 50));

      await lockClient.query("COMMIT");

      const [integrateResult, rejectResult] = await Promise.allSettled([integratePromise, rejectPromise]);
      expect(integrateResult.status).toBe("fulfilled");
      expect(rejectResult.status).toBe("fulfilled");
    } finally {
      lockClient.release();
    }

    const evidence = await retrieveContextChatbotEvidence({
      scope, query: "refund holds thirty days director sign-off",
      embeddingProvider: null, rerankProvider: null,
    });
    expect(evidence.knowledge.map((item) => item.content)).not.toContain(answer);
  });

  it("rejecting one duplicate does not un-publish an identical still-integrated insight", async () => {
    // Entries are keyed by content, so two candidates carrying the same answer share one
    // entry. Deleting on the first rejection would revoke a decision nobody reversed.
    const answer = "Partial refunds under the minimum threshold are auto-approved overnight.";
    const first = await savedAnswer(answer);
    const second = await savedAnswer(answer);
    await integrateProjectKnowledgeCandidate({ scope, candidateId: first.candidateId, actor: "admin-1" });
    await integrateProjectKnowledgeCandidate({ scope, candidateId: second.candidateId, actor: "admin-2" });

    await rejectProjectKnowledgeCandidate({
      scope, candidateId: first.candidateId, actor: "admin-1", reason: "duplicate",
    });

    const evidence = await retrieveContextChatbotEvidence({
      scope, query: "partial refunds minimum threshold auto approved",
      embeddingProvider: null, rerankProvider: null,
    });
    expect(evidence.knowledge.map((item) => item.content)).toContain(answer);
  });

  it("two concurrent integrations of identical answers index exactly one entry", async () => {
    // The race the advisory lock closes. Two candidates carrying the same content share
    // one entryKey, but hold different candidate rows — so the FOR UPDATE row locks do
    // not serialize them, and indexApprovedChatInsight is delete-then-insert with no
    // unique constraint backing it: under READ COMMITTED each transaction's DELETE
    // misses the other's uncommitted INSERT and both commit, duplicating the insight in
    // every prompt. Pre-holding the advisory lock externally guarantees both integrates
    // are provably in flight together before either can index; with the fix they queue
    // on it, without it the external lock is invisible to them and the race runs free.
    const answer = "Loyalty credits expire after eighteen months of account inactivity.";
    const first = await savedAnswer(answer);
    const second = await savedAnswer(answer);
    const entryKey = chatInsightEntryKey(answer);
    const [lockKey1, lockKey2] = chatInsightLockKey(scope, entryKey);

    const lockClient = await getPool().connect();
    try {
      await lockClient.query("BEGIN");
      await lockClient.query("SELECT pg_advisory_xact_lock($1, $2)", [lockKey1, lockKey2]);

      const firstPromise = integrateProjectKnowledgeCandidate({
        scope, candidateId: first.candidateId, actor: "admin-1",
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      const secondPromise = integrateProjectKnowledgeCandidate({
        scope, candidateId: second.candidateId, actor: "admin-2",
      });
      await new Promise((resolve) => setTimeout(resolve, 50));

      await lockClient.query("COMMIT");

      const [firstResult, secondResult] = await Promise.allSettled([firstPromise, secondPromise]);
      expect(firstResult.status).toBe("fulfilled");
      expect(secondResult.status).toBe("fulfilled");
    } finally {
      lockClient.release();
    }

    for (const table of ["project_knowledge_entries", "project_knowledge_entries_fts"] as const) {
      const rows = await sqlAll<{ id: string | null }>(
        `SELECT project_id AS id FROM ${table}
         WHERE project_id = @p AND category = 'chat_insight' AND entry_key = @entryKey`,
        { p: PROJ, entryKey },
      );
      expect(rows).toHaveLength(1);
    }
    const evidence = await retrieveContextChatbotEvidence({
      scope, query: "loyalty credits expire account inactivity",
      embeddingProvider: null, rerankProvider: null,
    });
    expect(evidence.knowledge.filter((item) => item.content === answer)).toHaveLength(1);
  }, 60_000);

  it("refuses to integrate a candidate that was rejected", async () => {
    const answer = "Vendor onboarding requires a signed data-processing agreement first.";
    const candidate = await savedAnswer(answer);
    await rejectProjectKnowledgeCandidate({
      scope, candidateId: candidate.candidateId, actor: "admin-1", reason: "not useful",
    });

    await expect(integrateProjectKnowledgeCandidate({
      scope, candidateId: candidate.candidateId, actor: "admin-2",
    })).rejects.toThrow(/rejected/i);

    const evidence = await retrieveContextChatbotEvidence({
      scope, query: "vendor onboarding data processing agreement",
      embeddingProvider: null, rerankProvider: null,
    });
    expect(evidence.knowledge.map((item) => item.content)).not.toContain(answer);
  });

  it("reaches an actual rendered workflow prompt alongside a real compiled snapshot, not just the assistant's own evidence", async () => {
    // The bug this guards: every workflow prompt builder reads project knowledge from
    // loadProjectKnowledgeContext, which for four rounds of review only ever returned the
    // compiler's own compiled snapshot (project_knowledge_base.validated_output) -- a
    // table integration never touched. An insight could become fully "integrated" and
    // still be invisible to every Requirement Analysis / Test Design / Test Case Review
    // prompt for the life of the project. Proving it in the
    // assistant's own evidence (the tests above) does not prove this; the assistant reads
    // project_knowledge_entries directly and was never the affected path.
    //
    // A real compiled snapshot is seeded here deliberately: every prior test in this file
    // has no project_knowledge_base row for this scope at all, so loadProjectKnowledgeContext
    // takes its "nothing compiled yet" branch -- a real project almost always has one, and
    // that branch merges chatInsights independently of this one.
    const now = new Date().toISOString();
    const snapshotId = uniqueTestId("pkb");
    await sqlRun(
      `INSERT INTO project_knowledge_base (
         id, project_id, azure_project_id, azure_project_name, azure_organization_url,
         prompt_version, provider, model_name, source_work_item_count, raw_output,
         validated_output, status, extracted_at, created_at, updated_at
       ) VALUES (
         @id, @projectId, @azureProjectId, @azureProjectName, @azureOrganizationUrl,
         'original', 'external', 'manual', 1, '{}', @validatedOutput, 'Success', @now, @now, @now
       )`,
      {
        id: snapshotId,
        projectId: PROJ,
        azureProjectId: PROJ,
        azureProjectName: scope.azureProjectName,
        azureOrganizationUrl: ORG,
        validatedOutput: JSON.stringify(compiledKnowledge()),
        now,
      },
    );

    const answer = "Escalations older than five business days route automatically to the duty manager.";
    const candidate = await savedAnswer(answer);
    await integrateProjectKnowledgeCandidate({ scope, candidateId: candidate.candidateId, actor: "admin-1" });

    const context = await loadProjectKnowledgeContext({ scope });
    // The compiled entry and the integrated insight must coexist: merging must not
    // replace one with the other.
    expect(context.knowledgeBase?.modules.map((m) => m.id)).toContain("billing-module");
    expect(context.knowledgeBase?.chatInsights.map((insight) => insight.content)).toContain(answer);

    const draft = buildRequirementAnalysisMarkdownPrompt({
      currentProject: { azureProjectId: scope.azureProjectId, azureProjectName: scope.azureProjectName },
      targetRequirement: { id: "9001", title: "Escalation handling" },
      projectKnowledgeBase: context.knowledgeBase,
      outputContract: {},
    });

    expect(draft.prompt).toContain(answer);
    expect(draft.prompt).toContain("Business Owner Assistant");
    expect(draft.prompt).toContain("Billing");

    await sqlRun(`DELETE FROM project_knowledge_base WHERE id = @id`, { id: snapshotId });
  });
});
