import { mergeConfig } from "vitest/config";

import integrationConfig from "./vitest.integration.config";

/**
 * Report-only PostgreSQL coverage. Kept separate from the ordinary integration
 * lane so local DB runs remain fast and coverage output is always intentional.
 *
 * The exact roots avoid filling this report with unrelated unit-only modules at
 * 0%. Thresholds are introduced only after CI establishes a stable baseline.
 */
export default mergeConfig(integrationConfig, {
  test: {
    coverage: {
      enabled: true,
      reportsDirectory: "./coverage/integration",
      include: [
        "src/modules/activity-log/activity-log.service.ts",
        "src/modules/analytics/system-dashboard.service.ts",
        "src/modules/analytics/workflow-analytics.service.ts",
        "src/modules/auth/session.service.ts",
        "src/modules/auth/user.service.ts",
        "src/modules/credentials/credential.service.ts",
        "src/modules/jobs/job-queue.service.ts",
        "src/modules/jobs/sync-schedule.service.ts",
        "src/modules/projects/workspace-projects.service.ts",
        "src/modules/rag/context-auto-update-run-history.service.ts",
        "src/modules/rag/project-context-store.service.ts",
        "src/modules/rag/project-knowledge-draft.service.ts",
        "src/modules/rag/project-knowledge.service.ts",
        "src/modules/security/rate-limit.ts",
        "src/modules/workspace/workspace-members.service.ts",
        "src/modules/workspace/workspace-settings.service.ts",
        "src/modules/workspace/workspace.service.ts",
        "src/worker/main.ts",
      ],
      thresholds: {
        "src/modules/rag/project-knowledge-draft.service.ts": {
          statements: 44,
          branches: 34,
          functions: 48,
          lines: 46,
        },
        "src/modules/rag/project-knowledge.service.ts": {
          statements: 24,
          branches: 15,
          functions: 31,
          lines: 25,
        },
      },
    },
  },
});
