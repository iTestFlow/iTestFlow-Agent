import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

describe("application supervisor", () => {
  it("is import-safe and exposes bounded generation-service restart backoff", () => {
    const moduleUrl = pathToFileURL(resolve(process.cwd(), "scripts/run-app.mjs")).href;
    const output = execFileSync(process.execPath, [
      "--input-type=module",
      "--eval",
      `const app = await import(${JSON.stringify(moduleUrl)}); process.stdout.write(JSON.stringify({ entry: app.isProcessEntrypoint, delays: [0,1,2,3,4,5,100].map(app.workerRestartDelay) }));`,
    ], { cwd: process.cwd(), encoding: "utf8" });
    expect(JSON.parse(output)).toEqual({
      entry: false,
      delays: [1_000, 2_000, 5_000, 15_000, 30_000, 30_000, 30_000],
    });
  });
});
