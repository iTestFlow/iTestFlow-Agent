/**
 * Single source of truth for the coverage configuration shared between
 * vitest.coverage.config.ts (enforcement) and src/test/coverage-gate.ts (the staleness
 * guard), so the two can never disagree.
 *
 * - GATED_INCLUDE: the risk-based gate's allowlist (thresholds are enforced on these).
 * - COVERAGE_EXCLUDE: files never measured for coverage (mirrored into the base config's
 *   coverage.exclude AND used by the guard to decide what is not "logic" to categorize).
 *
 * Sharing these literals means no fragile parsing of config source text. GATED_INCLUDE
 * entries must be exact file paths. Wildcards are intentionally unsupported so deleting
 * or renaming any gated source file always fails the integrity guard.
 */
export const GATED_INCLUDE: string[] = [
  "src/modules/analytics/analytics-metrics.ts",
  "src/modules/analytics/system-dashboard-scope.ts",
  "src/modules/auth/bootstrap.service.ts",
  "src/modules/auth/pat-auth-provider.ts",
  "src/modules/bug-reporting/schemas/bug-report.schema.ts",
  "src/modules/context-chatbot/context-chatbot-history.ts",
  "src/modules/context-selection/context-suggestion-sizing.ts",
  "src/modules/dashboard/dashboard-metrics.ts",
  "src/modules/dashboard/my-workbench-metrics.ts",
  "src/modules/existing-test-case-review/review-metrics.ts",
  "src/modules/existing-test-case-review/schemas/existing-test-case-review.schema.ts",
  "src/modules/integrations/azure-devops/azure-devops-mapper.ts",
  "src/modules/integrations/azure-devops/azure-devops-test-case-payload.ts",
  "src/modules/integrations/azure-devops/publish-normalization.ts",
  "src/modules/llm/context-used.ts",
  "src/modules/llm/external-structured-output.ts",
  "src/modules/llm/extra-instructions.ts",
  "src/modules/llm/llm-defaults.ts",
  "src/modules/llm/llm-warnings.ts",
  "src/modules/llm/manual-prompt.ts",
  "src/modules/llm/provider-base-url.ts",
  "src/modules/llm/prompt-payload.ts",
  "src/modules/llm/token-usage.ts",
  "src/modules/llm/providers/base-json-provider.ts",
  "src/modules/llm/providers/fetch-with-transient-retry.ts",
  "src/modules/llm/providers/provider-param-compat.ts",
  "src/modules/projects/project-isolation.guard.ts",
  "src/modules/rag/knowledge-error-classification.ts",
  "src/modules/rag/local-vector-store.ts",
  "src/modules/rag/rag-pipeline.service.ts",
  "src/modules/rag/retrieval-config.ts",
  "src/modules/rag/workflow-context-citations.ts",
  "src/modules/requirement-analysis/comment/requirement-analysis-comment.ts",
  "src/modules/scoring/scoring.service.ts",
  "src/modules/security/encryption.service.ts",
  "src/modules/settings/cron-expression.ts",
  "src/modules/shared/errors/app-error.ts",
  "src/modules/shared/errors/error-response.ts",
  "src/modules/test-case-design/test-design-options.ts",
  "src/modules/test-case-design/schemas/test-case.schema.ts",
  "src/modules/test-execution-effort/test-execution-effort.schema.ts",
  "src/modules/test-suite-migration/test-suite-migration.logic.ts",
  "src/modules/test-suite-migration/test-suite-migration.schema.ts",
  "src/modules/workspace/workspace-request.ts",
  "src/app/report-bug/lib/reproduction-test-case.ts",
  "src/app/requirements-analysis/lib/comment-helpers.ts",
  "src/app/suite-migration/lib/suite-tree.ts",
  "src/app/test-gap-analysis/lib/findings-filters.ts",
  "src/app/test-gap-analysis/lib/matrix-filters.ts",
  "src/app/test-gap-analysis/lib/summary-key-points.ts",
  "src/components/layout/topbar-labels.ts",
  "src/components/workflow/post-json.ts",
  "src/shared/lib/active-project.ts",
  "src/shared/lib/cron-schedule.ts",
];

/**
 * Files never measured for coverage. Mirrored into vitest.config.ts coverage.exclude
 * (the actual instrumentation) and applied by the staleness guard so its "logic universe"
 * excludes exactly what coverage excludes. Supports `**`, single `*`, and `{a,b}` braces.
 */
export const COVERAGE_EXCLUDE: string[] = [
  "src/**/*.test.{ts,tsx}",
  "src/**/*.spec.{ts,tsx}",
  "src/**/*.d.ts",
  "src/**/*-types.ts",
  "src/**/types.ts",
  "src/modules/integrations/azure-devops/azure-devops-adapter.ts",
  "src/modules/shared/infrastructure/database/db.ts",
  "src/components/workflow/llm-loading-games/*.tsx",
];
