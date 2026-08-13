import { describe, expect, it, vi } from "vitest";

import { PlaywrightMcpExecutor } from "./playwright-mcp-executor";

type RecoveryHarness = {
  allowedOrigin: string;
  takeSnapshot: () => Promise<{ text: string; url: string | null }>;
  recoverUsableInitialPage: (navigationError: string) => Promise<boolean>;
};

function recoveryHarness(snapshot: { text: string; url: string | null }): RecoveryHarness {
  const executor = new PlaywrightMcpExecutor() as unknown as RecoveryHarness;
  executor.allowedOrigin = "https://app.example.com";
  executor.takeSnapshot = vi.fn(async () => snapshot);
  return executor;
}

describe("PlaywrightMcpExecutor initial navigation recovery", () => {
  it("recovers a startup timeout when the rendered page is usable at the allowed origin", async () => {
    const executor = recoveryHarness({ text: "- Page URL: https://app.example.com/\n- heading Home", url: "https://app.example.com/" });

    await expect(executor.recoverUsableInitialPage("Timeout 30000ms exceeded")).resolves.toBe(true);
  });

  it("does not recover a timeout when the page is outside the allowed origin", async () => {
    const executor = recoveryHarness({ text: "- Page URL: https://untrusted.example/", url: "https://untrusted.example/" });

    await expect(executor.recoverUsableInitialPage("Timeout 30000ms exceeded")).resolves.toBe(false);
  });

  it("does not hide non-timeout navigation errors", async () => {
    const executor = recoveryHarness({ text: "- Page URL: https://app.example.com/", url: "https://app.example.com/" });

    await expect(executor.recoverUsableInitialPage("net::ERR_NAME_NOT_RESOLVED")).resolves.toBe(false);
    expect(executor.takeSnapshot).not.toHaveBeenCalled();
  });
});
