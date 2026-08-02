import "server-only";

import { assertProjectScope, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import { retrieveContextChatbotEvidence } from "@/modules/rag/context-chatbot-retrieval.service";
import { listProjectKnowledgeBenchmarkCases } from "@/modules/rag/project-knowledge-benchmark.service";
import { normalizeExpectedWorkItemId } from "@/modules/rag/work-item-id";
import {
  reciprocalRank,
  recallAtK,
  summarizeBenchmarkRun,
  type BenchmarkRunSummary,
} from "@/modules/rag/retrieval-benchmark-scorer";

// Imported, not restated: a benchmark that measures different retrieval settings from the
// ones production uses stops being a benchmark the moment either side is tuned, and a
// comment claiming two copies "mirror" each other cannot enforce that. Evidence-budget's
// later token trimming is deliberately out of scope here — that is a prompt-size concern,
// not a ranking-quality one.
import {
  CONTEXT_CANDIDATE_LIMIT,
  KNOWLEDGE_CANDIDATE_LIMIT,
  MAX_CONTEXT_CHUNKS_PER_WORK_ITEM,
} from "@/modules/context-chatbot/context-chatbot.service";

export type RetrievalBenchmarkCaseResult = {
  caseId: string;
  question: string;
  expectedWorkItemId: string;
  rankedWorkItemIds: string[];
  recallAt1: boolean;
  reciprocalRank: number;
};

export type RetrievalBenchmarkRunResult = {
  caseCount: number;
  results: RetrievalBenchmarkCaseResult[];
  summary: BenchmarkRunSummary;
};

/**
 * Scores the real retrieval path against every labeled benchmark case for a project:
 * for each collected, human-labeled question, runs the same retrieval the Business
 * Owner Assistant uses and checks whether the admin-specified expected work item comes
 * back, and how highly ranked it is. Unlabeled cases are excluded (there is nothing to
 * score them against) — see project-knowledge-benchmark.service.ts's labeledOnly filter.
 */
export async function runRetrievalBenchmark(input: { scope: ProjectScope }): Promise<RetrievalBenchmarkRunResult> {
  const scope = assertProjectScope(input.scope);
  const labeledCases = await listProjectKnowledgeBenchmarkCases({ scope, labeledOnly: true, limit: 500 });

  const results: RetrievalBenchmarkCaseResult[] = [];
  for (const benchmarkCase of labeledCases) {
    // Guaranteed by labeledOnly, but keeps the result type's expectedWorkItemId non-nullable.
    if (!benchmarkCase.expectedWorkItemId) continue;
    // Labels written before normalization-at-write landed can still carry "AB#1234"
    // shapes; retrieval returns plain numeric ids, so normalize at compare too. The
    // scorer itself stays pure exact-match.
    const expectedWorkItemId =
      normalizeExpectedWorkItemId(benchmarkCase.expectedWorkItemId) ?? benchmarkCase.expectedWorkItemId;

    const evidence = await retrieveContextChatbotEvidence({
      scope,
      query: benchmarkCase.question,
      contextLimit: CONTEXT_CANDIDATE_LIMIT,
      knowledgeLimit: KNOWLEDGE_CANDIDATE_LIMIT,
      maxContextChunksPerWorkItem: MAX_CONTEXT_CHUNKS_PER_WORK_ITEM,
    });
    const rankedWorkItemIds = dedupeWorkItemIds(evidence.context.map((item) => item.workItemId));

    results.push({
      caseId: benchmarkCase.id,
      question: benchmarkCase.question,
      expectedWorkItemId,
      rankedWorkItemIds,
      recallAt1: recallAtK(rankedWorkItemIds, expectedWorkItemId, 1),
      reciprocalRank: reciprocalRank(rankedWorkItemIds, expectedWorkItemId),
    });
  }

  const summary = summarizeBenchmarkRun(
    results.map((result) => ({ rankedWorkItemIds: result.rankedWorkItemIds, expectedWorkItemId: result.expectedWorkItemId })),
  );

  return { caseCount: results.length, results, summary };
}

/**
 * Evidence chunks are per-chunk, so the same work item can appear up to
 * MAX_CONTEXT_CHUNKS_PER_WORK_ITEM times. Recall/MRR are about work-item rank, so
 * collapse to first-occurrence order — otherwise a duplicate could occupy a top-k slot
 * a different, lower-ranked work item should have counted against.
 */
function dedupeWorkItemIds(workItemIds: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const id of workItemIds) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    deduped.push(id);
  }
  return deduped;
}
