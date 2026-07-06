import { mergeConfig } from "vitest/config";

import unitConfig from "./vitest.unit.config";

export default mergeConfig(unitConfig, {
  test: {
    coverage: {
      reportsDirectory: "./coverage/all",
      include: [
        "src/modules/**/*.ts",
        "src/app/api/**/route.ts",
        "src/app/**/*-client.tsx",
        "src/app/report-bug/lib/**/*.ts",
        "src/app/requirements-analysis/lib/**/*.ts",
        "src/app/suite-migration/lib/**/*.ts",
        "src/shared/lib/**/*.ts",
        "src/lib/**/*.ts",
        "src/worker/**/*.ts",
        "src/components/activity-log/**/*.{ts,tsx}",
        "src/components/dashboard/**/*.{ts,tsx}",
        "src/components/workflow/**/*.{ts,tsx}",
        "src/app/test-gap-analysis/lib/**/*.ts",
      ],
      thresholds: {},
    },
  },
});
