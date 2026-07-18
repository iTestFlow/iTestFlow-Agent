import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

const moduleUrl = pathToFileURL(resolve(process.cwd(), "scripts/run-app.mjs")).href;

type SupervisorModule = {
  isProcessEntrypoint: boolean;
  workerRestartDelay: (attempt: number) => number;
  requestWorkerShutdown: (child: unknown) => boolean;
  WORKER_SHUTDOWN_MESSAGE: string;
};

describe("application supervisor", () => {
  it("is import-safe and exposes bounded generation-service restart backoff", () => {
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

  it("delivers the worker shutdown message over stdin and reports undeliverable channels", async () => {
    const app = await import(/* @vite-ignore */ moduleUrl) as SupervisorModule;

    const writes: string[] = [];
    const end = vi.fn();
    const liveChild = {
      exitCode: null,
      killed: false,
      stdin: { destroyed: false, write: (chunk: unknown) => { writes.push(String(chunk)); return true; }, end },
    };
    expect(app.requestWorkerShutdown(liveChild)).toBe(true);
    expect(writes).toEqual([`${app.WORKER_SHUTDOWN_MESSAGE}\n`]);
    expect(end).toHaveBeenCalledTimes(1);

    const exitedChild = {
      exitCode: 0,
      killed: false,
      stdin: { destroyed: false, write: vi.fn(), end: vi.fn() },
    };
    expect(app.requestWorkerShutdown(exitedChild)).toBe(false);
    expect(exitedChild.stdin.write).not.toHaveBeenCalled();

    const closedStdinChild = {
      exitCode: null,
      killed: false,
      stdin: { destroyed: true, write: vi.fn(), end: vi.fn() },
    };
    expect(app.requestWorkerShutdown(closedStdinChild)).toBe(false);
    expect(app.requestWorkerShutdown(undefined)).toBe(false);
  });

  it("pins the shutdown message literal mirrored in src/worker/main.ts", async () => {
    const app = await import(/* @vite-ignore */ moduleUrl) as SupervisorModule;
    // The worker-side pin lives in src/worker/main.test.ts; drift in either
    // constant breaks its own suite.
    expect(app.WORKER_SHUTDOWN_MESSAGE).toBe("shutdown");
  });
});
