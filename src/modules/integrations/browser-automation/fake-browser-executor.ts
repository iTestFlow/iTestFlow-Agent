import type { AgentAction } from "@/modules/test-execution/action-schema";
import {
  BrowserExecutorError,
  type ActionExecutionResult,
  type BrowserExecutor,
  type BrowserSessionConfig,
  type PageSnapshot,
} from "./browser-executor.port";

/**
 * Deterministic scripted executor for agentic-loop, handler, and route
 * tests. Feed it snapshots and per-action results; it records the actions it
 * received and honors abort/dispose semantics like the real adapter.
 */

const OK: ActionExecutionResult = { status: "ok", observation: { durationMs: 1 } };
const DEFAULT_SNAPSHOT = '- button "Save" [ref=e1]\n- textbox "Email" [ref=e2]';

export type FakeActionScriptEntry = ActionExecutionResult | { throw: string } | "ok";

export class FakeBrowserExecutor implements BrowserExecutor {
  readonly executedActions: AgentAction[] = [];
  startedWith: BrowserSessionConfig | null = null;
  disposeCount = 0;
  screenshotCount = 0;
  snapshotCount = 0;

  private actionScript: FakeActionScriptEntry[];
  private snapshots: string[];
  private consoleErrors: string[];
  private url: string | null = null;
  private signal: AbortSignal | null = null;
  private started = false;
  private failStart: boolean;

  constructor(options?: {
    actionScript?: FakeActionScriptEntry[];
    snapshots?: string[];
    consoleErrors?: string[];
    failStart?: boolean;
  }) {
    this.actionScript = options?.actionScript ? [...options.actionScript] : [];
    this.snapshots = options?.snapshots ? [...options.snapshots] : [];
    this.consoleErrors = options?.consoleErrors ? [...options.consoleErrors] : [];
    this.failStart = options?.failStart ?? false;
  }

  async start(config: BrowserSessionConfig): Promise<void> {
    if (this.failStart) throw new BrowserExecutorError("fake start failure");
    this.startedWith = config;
    this.signal = config.signal;
    this.url = config.initialUrl;
    this.started = true;
  }

  async takeSnapshot(): Promise<PageSnapshot> {
    if (!this.started) throw new BrowserExecutorError("takeSnapshot before start");
    if (this.signal?.aborted) throw new BrowserExecutorError("aborted");
    this.snapshotCount += 1;
    const text = this.snapshots.length > 1 ? (this.snapshots.shift() as string) : (this.snapshots[0] ?? DEFAULT_SNAPSHOT);
    return { text, url: this.url };
  }

  async performAgentAction(action: AgentAction): Promise<ActionExecutionResult> {
    if (!this.started) throw new BrowserExecutorError("performAgentAction before start");
    if (this.signal?.aborted) throw new BrowserExecutorError("aborted");
    this.executedActions.push(action);
    if (action.type === "navigate") this.url = action.url;

    const entry = this.actionScript.shift() ?? "ok";
    if (entry === "ok") return OK;
    if (typeof entry === "object" && "throw" in entry) {
      throw new BrowserExecutorError(entry.throw);
    }
    return entry;
  }

  async captureScreenshot(): Promise<{ bytes: Buffer; mimeType: string }> {
    this.screenshotCount += 1;
    return { bytes: Buffer.from(`fake-screenshot-${this.screenshotCount}`), mimeType: "image/png" };
  }

  async drainConsoleErrors(): Promise<string[]> {
    const drained = this.consoleErrors;
    this.consoleErrors = [];
    return drained;
  }

  async currentUrl(): Promise<string | null> {
    return this.url;
  }

  async dispose(): Promise<void> {
    this.disposeCount += 1;
    this.started = false;
  }
}
