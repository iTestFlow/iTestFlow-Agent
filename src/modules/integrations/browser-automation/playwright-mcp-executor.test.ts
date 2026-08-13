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

type NavigationHarness = {
  allowedOrigin: string;
  lastKnownUrl: string | null;
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  performAgentAction: PlaywrightMcpExecutor["performAgentAction"];
};

function navigationHarness(currentUrl: string | null): NavigationHarness {
  const executor = new PlaywrightMcpExecutor() as unknown as NavigationHarness;
  executor.allowedOrigin = "https://app.example.com";
  executor.lastKnownUrl = currentUrl;
  executor.callTool = vi.fn(async () => ({ text: "", isError: false, images: [] }));
  return executor;
}

describe("PlaywrightMcpExecutor redundant navigation", () => {
  it("answers from state instead of re-navigating to the open page", async () => {
    // A second browser_navigate wedges the MCP backend on some sites, taking
    // every later tool call — including the snapshot — down with it.
    const executor = navigationHarness("https://app.example.com/");

    const result = await executor.performAgentAction({ type: "navigate", url: "https://app.example.com/" });

    expect(result.status).toBe("ok");
    expect(result.observation.detail).toBe("already on the requested page");
    expect(executor.callTool).not.toHaveBeenCalled();
  });

  it.each([
    ["a trailing slash", "https://app.example.com/products", "/products/"],
    ["a relative target", "https://app.example.com/login", "/login"],
  ])("treats %s as the same page", async (_label, currentUrl, requested) => {
    const executor = navigationHarness(currentUrl);

    const result = await executor.performAgentAction({ type: "navigate", url: requested });

    expect(result.status).toBe("ok");
    expect(executor.callTool).not.toHaveBeenCalled();
  });

  it.each([
    ["a different query string", "https://app.example.com/reports?range=7d", "/reports?range=90d"],
    ["a query string where there was none", "https://app.example.com/reports", "/reports?range=90d"],
    ["a different fragment", "https://app.example.com/docs#intro", "/docs#billing"],
  ])("still navigates for %s", async (_label, currentUrl, requested) => {
    // Same path, different content: skipping this would silently drop a
    // navigation the step asked for.
    const executor = navigationHarness(currentUrl);

    await executor.performAgentAction({ type: "navigate", url: requested });

    expect(executor.callTool).toHaveBeenCalled();
  });

  it("still navigates when the target is a different page", async () => {
    const executor = navigationHarness("https://app.example.com/");

    await executor.performAgentAction({ type: "navigate", url: "/checkout" });

    expect(executor.callTool).toHaveBeenCalledWith("browser_navigate", { url: "/checkout" });
  });

  it("still navigates when no page is known yet", async () => {
    const executor = navigationHarness(null);

    await executor.performAgentAction({ type: "navigate", url: "https://app.example.com/" });

    expect(executor.callTool).toHaveBeenCalled();
  });

  it("rejects an off-origin target before considering the current page", async () => {
    const executor = navigationHarness("https://untrusted.example/");

    const result = await executor.performAgentAction({ type: "navigate", url: "https://untrusted.example/" });

    expect(result).toMatchObject({ status: "failed", reason: "policy_violation" });
    expect(executor.callTool).not.toHaveBeenCalled();
  });
});
