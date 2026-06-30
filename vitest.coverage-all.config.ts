import { mergeConfig } from "vitest/config";

import unitConfig from "./vitest.unit.config";

export default mergeConfig(unitConfig, {
  test: {
    coverage: {
      reportsDirectory: "./coverage/all",
      include: [
        "src/modules/**/*.ts",
        "src/shared/lib/**/*.ts",
        "src/components/workflow/**/*.{ts,tsx}",
        "src/app/test-gap-analysis/lib/**/*.ts",
      ],
      thresholds: {},
    },
  },
});
