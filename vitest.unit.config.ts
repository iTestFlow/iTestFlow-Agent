import { mergeConfig } from "vitest/config";

import baseConfig from "./vitest.config";

export default mergeConfig(baseConfig, {
  test: {
    // The unit lane: every test EXCEPT the DB-backed *.db.test.* files. (Selection is
    // declared here rather than in the base so it does not concatenate into the
    // integration lane's include — see vitest.config.ts.)
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["src/**/*.db.test.{ts,tsx}"],
    // GitHub Actions runs the coverage config, which inherits this lane. Emit
    // distinctly named JUnit and JSON reports for the consolidated CI summary.
    // Explicitly selecting reporters also prevents Vitest from appending its
    // anonymous, auto-enabled GitHub job summary for every test invocation.
    reporters:
      process.env.GITHUB_ACTIONS === "true"
        ? ["default", ["junit", { suiteName: "Unit & coverage" }], "json"]
        : undefined,
    outputFile:
      process.env.GITHUB_ACTIONS === "true"
        ? {
            junit: "./reports/unit.xml",
            json: "./reports/unit.json",
          }
        : undefined,
  },
});
