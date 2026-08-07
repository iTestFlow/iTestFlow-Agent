import "server-only";

import { buildScrubValues } from "@/modules/test-execution/secret-resolution";
import type { AgentAction } from "@/modules/test-execution/action-schema";

import { planAgentAction } from "./action-tool-mapping";
import { findSnapshotCheckedState } from "./aria-snapshot";
import {
  BrowserExecutorError,
  type ActionExecutionResult,
  type BrowserExecutor,
  type BrowserSessionConfig,
  type PageSnapshot,
} from "./browser-executor.port";
import { findMissingMcpTools, isAllowedMcpTool, type AllowedMcpTool } from "./mcp-tool-allowlist";
import { startMcpSession, type McpSession } from "./mcp-process";
import { createScrubber, type Scrubber } from "./output-scrubber";

/**
 * Playwright MCP adapter for agentic execution: exposes the accessibility
 * snapshot (what the model sees) and executes validated ref-based actions
 * through the allowlisted tool surface of the pinned @playwright/mcp@0.0.78
 * child process. Never guesses: a stale/unknown ref comes back as a failed
 * result the loop feeds back to the model with a fresh snapshot.
 */

const PAGE_URL_PATTERN = /^- Page URL: (.+)$/m;

type ToolCallOutcome = { text: string; isError: boolean; images: { data: string; mimeType: string }[] };

export class PlaywrightMcpExecutor implements BrowserExecutor {
  private session: McpSession | null = null;
  private config: BrowserSessionConfig | null = null;
  private scrub: Scrubber = (text) => text;
  private lastKnownUrl: string | null = null;
  private lastSnapshotText = "";
  private allowedOrigin = "";
  private onAbort: (() => void) | null = null;

  async start(config: BrowserSessionConfig): Promise<void> {
    this.config = config;
    this.scrub = createScrubber(buildScrubValues(config.secrets));
    try {
      this.allowedOrigin = new URL(config.allowedOrigin).origin;
    } catch (error) {
      throw new BrowserExecutorError(`Invalid allowed origin: ${config.allowedOrigin}`, error);
    }

    this.session = await startMcpSession({
      runId: config.runId,
      headless: config.headless,
      viewport: config.viewport,
      actionTimeoutMs: config.defaultTimeoutMs,
      navigationTimeoutMs: config.navigationTimeoutMs,
    });

    this.onAbort = () => {
      void this.dispose();
    };
    config.signal.addEventListener("abort", this.onAbort, { once: true });
    if (config.signal.aborted) {
      await this.dispose();
      throw new BrowserExecutorError("Session aborted before start completed.");
    }

    const advertised = await this.session.client.listTools();
    const missing = findMissingMcpTools(advertised.tools.map((tool) => tool.name));
    if (missing.length > 0) {
      await this.dispose();
      throw new BrowserExecutorError(
        `Playwright MCP tool surface drifted from the pinned version; missing: ${missing.join(", ")}`,
      );
    }

    const initial = await this.callTool("browser_navigate", { url: config.initialUrl });
    if (initial.isError) {
      await this.dispose();
      throw new BrowserExecutorError(
        `Could not open the environment's initial URL: ${this.scrub(initial.text).slice(0, 500)}`,
      );
    }
  }

  async takeSnapshot(): Promise<PageSnapshot> {
    const outcome = await this.callTool("browser_snapshot", {});
    if (outcome.isError) {
      throw new BrowserExecutorError(`Snapshot failed: ${this.scrub(outcome.text).slice(0, 500)}`);
    }
    this.lastSnapshotText = outcome.text;
    return { text: this.scrub(outcome.text), url: this.lastKnownUrl };
  }

  async performAgentAction(action: AgentAction): Promise<ActionExecutionResult> {
    const startedAt = Date.now();
    const plan = planAgentAction(action);
    const result = await this.executePlan(action, plan);
    result.observation.durationMs = Date.now() - startedAt;
    if (this.lastKnownUrl) result.observation.url = this.lastKnownUrl;
    return result;
  }

  private async executePlan(
    action: AgentAction,
    plan: ReturnType<typeof planAgentAction>,
  ): Promise<ActionExecutionResult> {
    switch (plan.kind) {
      case "tool": {
        // Defense in depth: navigation origin was validated by the loop, but
        // re-check here so the adapter alone can never leave the origin.
        if (action.type === "navigate") {
          let origin = "";
          try {
            origin = new URL(action.url, this.allowedOrigin).origin;
          } catch {
            origin = "";
          }
          if (origin !== this.allowedOrigin) {
            return this.failed("policy_violation", `Navigation outside ${this.allowedOrigin} is not allowed.`);
          }
        }
        const outcome = await this.callTool(plan.tool, plan.args);
        if (!outcome.isError) return this.ok();
        return this.classifyToolError(plan.tool, outcome.text);
      }
      case "toggle": {
        const currentState = findSnapshotCheckedState(this.lastSnapshotText, plan.ref);
        if (currentState !== null && currentState === plan.desired) {
          return this.ok("already in desired state");
        }
        const click = await this.callTool("browser_click", {
          target: plan.ref,
          element: plan.elementDescription,
        });
        if (click.isError) return this.classifyToolError("browser_click", click.text);
        const verify = await this.callTool("browser_verify_value", {
          type: "checkbox",
          element: plan.elementDescription,
          target: plan.ref,
          value: plan.desired ? "true" : "false",
        });
        if (verify.isError) {
          return this.failed("element_state", `Toggle did not reach the desired state: ${this.scrub(verify.text).slice(0, 300)}`);
        }
        return this.ok();
      }
      case "screenshot": {
        await this.captureToolScreenshot();
        return this.ok("screenshot captured");
      }
    }
  }

  private classifyToolError(tool: AllowedMcpTool, text: string): ActionExecutionResult {
    const detail = this.scrub(text).slice(0, 500);
    if (/timeout/i.test(text)) return this.failed("timeout", detail);
    if (/ref|not found|no element|snapshot|stale|resolve/i.test(text)) {
      return this.failed("invalid_target", detail);
    }
    if (tool === "browser_navigate") {
      throw new BrowserExecutorError(`Navigation failed: ${detail}`);
    }
    return this.failed("element_state", detail);
  }

  private lastScreenshot: { bytes: Buffer; mimeType: string } | null = null;

  private async captureToolScreenshot(): Promise<void> {
    const outcome = await this.callTool("browser_take_screenshot", {});
    if (outcome.isError) {
      throw new BrowserExecutorError(`Screenshot failed: ${this.scrub(outcome.text).slice(0, 300)}`);
    }
    const image = outcome.images[0];
    if (!image) throw new BrowserExecutorError("Screenshot returned no image content.");
    this.lastScreenshot = { bytes: Buffer.from(image.data, "base64"), mimeType: image.mimeType };
  }

  async captureScreenshot(): Promise<{ bytes: Buffer; mimeType: string }> {
    await this.captureToolScreenshot();
    if (!this.lastScreenshot) throw new BrowserExecutorError("Screenshot capture produced no data.");
    return this.lastScreenshot;
  }

  async drainConsoleErrors(): Promise<string[]> {
    const outcome = await this.callTool("browser_console_messages", { level: "error" });
    if (outcome.isError) return [];
    return outcome.text
      .split("\n")
      .map((line) => this.scrub(line.trim()))
      .filter((line) => line.length > 0 && !line.startsWith("- Page ") && !line.startsWith("### "))
      .slice(0, 100);
  }

  async currentUrl(): Promise<string | null> {
    if (this.lastKnownUrl) return this.lastKnownUrl;
    if (!this.session) return null;
    await this.takeSnapshot().catch(() => undefined);
    return this.lastKnownUrl;
  }

  async dispose(): Promise<void> {
    if (this.onAbort && this.config) {
      this.config.signal.removeEventListener("abort", this.onAbort);
      this.onAbort = null;
    }
    const session = this.session;
    this.session = null;
    if (session) await session.close();
  }

  private async callTool(name: AllowedMcpTool, args: Record<string, unknown>): Promise<ToolCallOutcome> {
    if (!this.session) throw new BrowserExecutorError("Executor session is not started.");
    if (!isAllowedMcpTool(name)) {
      throw new BrowserExecutorError(`Tool ${name} is not in the execution allowlist.`);
    }
    if (this.config?.signal.aborted) throw new BrowserExecutorError("Execution aborted.");

    let response;
    try {
      response = await this.session.client.callTool(
        { name, arguments: args },
        undefined,
        { timeout: Math.max(this.config?.navigationTimeoutMs ?? 60_000, 60_000) + 15_000 },
      );
    } catch (error) {
      throw new BrowserExecutorError(`MCP call ${name} failed at the protocol level.`, error);
    }

    const content = Array.isArray(response.content) ? response.content : [];
    const text = content
      .filter((item): item is { type: "text"; text: string } => item.type === "text")
      .map((item) => item.text)
      .join("\n");
    const images = content
      .filter(
        (item): item is { type: "image"; data: string; mimeType: string } => item.type === "image",
      )
      .map((item) => ({ data: item.data, mimeType: item.mimeType }));

    const urlMatch = PAGE_URL_PATTERN.exec(text);
    if (urlMatch) this.lastKnownUrl = urlMatch[1].trim();

    return { text, isError: response.isError === true, images };
  }

  private ok(detail?: string): ActionExecutionResult {
    return { status: "ok", observation: { durationMs: 0, detail } };
  }

  private failed(
    reason: "timeout" | "invalid_target" | "element_state" | "policy_violation",
    detail?: string,
  ): ActionExecutionResult {
    return { status: "failed", reason, observation: { durationMs: 0, detail } };
  }
}
