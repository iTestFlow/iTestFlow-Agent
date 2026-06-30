import { mergeConfig } from "vitest/config";

import baseConfig from "./vitest.config";

export default mergeConfig(baseConfig, {
  test: {
    // The unit lane: every test EXCEPT the DB-backed *.db.test.* files. (Selection is
    // declared here rather than in the base so it does not concatenate into the
    // integration lane's include — see vitest.config.ts.)
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["src/**/*.db.test.{ts,tsx}"],
  },
});
