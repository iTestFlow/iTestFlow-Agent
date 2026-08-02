/**
 * Scores the real Business Owner Assistant retrieval path against every admin-labeled
 * retrieval benchmark case, for every project that has at least one. Prints MRR and
 * recall@k per project so a retrieval change (adaptive K, reranking, fusion weights, ...)
 * can be checked against real collected questions instead of guessed at.
 *
 * Run:
 *   npm run benchmark:run
 *
 * Env: DATABASE_URL. Embeddings and reranking run on the pinned in-process local
 * models (see embedding-provider.ts / rerank-provider.ts) — the same models
 * production uses; there is no embedding backend configuration.
 */
import { sqlAll } from "@/modules/shared/infrastructure/database/db";
import type { ProjectScope } from "@/modules/projects/project-isolation.guard";
import { runRetrievalBenchmark, type RetrievalBenchmarkRunResult } from "@/modules/rag/retrieval-benchmark-runner.service";

type LabeledProjectRow = {
  project_id: string;
  azure_project_id: string;
  azure_project_name: string;
  azure_org_url: string;
  workspace_id: string;
};

/**
 * There is no general "list all projects" service function, so this queries the
 * benchmark table directly for the distinct projects that have at least one labeled
 * case, joined against `projects`/`workspaces` for the display name and the
 * canonical org URL (workspaces.azure_org_url, not the projects table's own copy —
 * matching resolveProjectScope's own trusted-scope convention).
 */
async function loadProjectsWithLabeledCases(): Promise<ProjectScope[]> {
  const rows = await sqlAll<LabeledProjectRow>(`
    SELECT DISTINCT
      bc.project_id, bc.azure_project_id, p.azure_project_name, w.azure_org_url, bc.workspace_id
    FROM project_knowledge_benchmark_cases bc
    JOIN projects p ON p.id = bc.project_id
    JOIN workspaces w ON w.id = bc.workspace_id
    WHERE bc.active = true AND bc.expected_work_item_id IS NOT NULL
    ORDER BY bc.project_id
  `);
  return rows.map((row) => ({
    projectId: row.project_id,
    azureProjectId: row.azure_project_id,
    azureProjectName: row.azure_project_name,
    azureOrganizationUrl: row.azure_org_url,
    workspaceId: row.workspace_id,
  }));
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function printReport(scope: ProjectScope, run: RetrievalBenchmarkRunResult): void {
  console.log(`\n${scope.azureProjectName} (${scope.azureProjectId})`);
  console.log(`  Labeled cases scored: ${run.caseCount}`);
  console.log(`  MRR: ${run.summary.mrr.toFixed(3)}`);
  for (const [k, recall] of Object.entries(run.summary.recallAtK)) {
    console.log(`  Recall@${k}: ${formatPercent(recall)}`);
  }

  const misses = run.results.filter((result) => !result.recallAt1);
  if (misses.length) {
    console.log(`  Missed at rank 1 (${misses.length}):`);
    for (const miss of misses) {
      const position = miss.rankedWorkItemIds.indexOf(miss.expectedWorkItemId);
      const rank = position === -1 ? "not retrieved" : `found at rank ${position + 1}`;
      console.log(`    - "${miss.question}" -> expected ${miss.expectedWorkItemId}, ${rank}`);
    }
  }
}

async function main() {
  const scopes = await loadProjectsWithLabeledCases();
  if (!scopes.length) {
    console.log("No projects have labeled retrieval benchmark cases yet. Label some from Knowledge Hub first.");
    return;
  }

  console.log(`Running retrieval benchmark for ${scopes.length} project(s)...`);
  for (const scope of scopes) {
    const run = await runRetrievalBenchmark({ scope });
    printReport(scope, run);
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
