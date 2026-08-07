import { PlaywrightMcpExecutor } from "@/modules/integrations/browser-automation/playwright-mcp-executor";

/**
 * Dev-only smoke test for the live Playwright MCP adapter (agentic surface).
 * Not a test lane — run it manually against a reachable app:
 *
 *   npm run browser:install          # once per machine
 *   npm run test-execution:smoke -- https://playwright.dev
 *
 * It starts an isolated headless session, takes an accessibility snapshot,
 * performs a ref-based click on the first available element, captures a
 * screenshot, and tears down. Exit code 0 means the product-callable MCP
 * path works on this machine.
 */

async function main(): Promise<void> {
  const url = process.argv[2];
  if (!url) {
    console.error("Usage: npm run test-execution:smoke -- <url>");
    process.exit(2);
  }
  const origin = new URL(url).origin;
  const controller = new AbortController();
  const executor = new PlaywrightMcpExecutor();

  console.log(`[smoke] starting MCP session against ${url}`);
  await executor.start({
    runId: "smoke",
    initialUrl: url,
    allowedOrigin: origin,
    viewport: { width: 1280, height: 720 },
    headless: true,
    defaultTimeoutMs: 10_000,
    navigationTimeoutMs: 30_000,
    secrets: new Map(),
    signal: controller.signal,
  });

  try {
    const snapshot = await executor.takeSnapshot();
    console.log(`[smoke] snapshot: ${snapshot.text.length} chars, url=${snapshot.url}`);
    const refMatch = /\[ref=([a-z0-9]+)\]/.exec(snapshot.text);
    if (!refMatch) throw new Error("snapshot contained no element refs");

    const click = await executor.performAgentAction({
      type: "click",
      ref: refMatch[1],
      elementDescription: "first snapshot element",
    });
    console.log("[smoke] ref click:", click.status);

    const ghost = await executor.performAgentAction({
      type: "click",
      ref: "zz999",
      elementDescription: "nonexistent element",
    });
    console.log("[smoke] expected failed click:", ghost.status, "reason" in ghost ? ghost.reason : "");

    const screenshot = await executor.captureScreenshot();
    console.log(`[smoke] screenshot: ${screenshot.bytes.length} bytes (${screenshot.mimeType})`);

    const consoleErrors = await executor.drainConsoleErrors();
    console.log(`[smoke] console errors: ${consoleErrors.length}`);

    if (ghost.status !== "failed") throw new Error("nonexistent ref did not fail");
    console.log("[smoke] OK — live MCP agentic execution path verified");
  } finally {
    await executor.dispose();
  }
}

main().catch((error) => {
  console.error("[smoke] FAILED:", error);
  process.exitCode = 1;
});
