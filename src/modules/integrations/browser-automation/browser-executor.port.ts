import type { AgentAction } from "@/modules/test-execution/action-schema";

/**
 * Provider-neutral browser execution contract — agentic runtime shape.
 *
 * The agentic step executor drives this port: takeSnapshot() feeds the model,
 * performAgentAction() executes a decision that has ALREADY passed the
 * deterministic validation in agent-decision.ts. Rule of the port:
 * infrastructure errors THROW (browser died, MCP protocol failure); action
 * outcomes RETURN as values so the loop can feed them back to the model.
 *
 * Implementations: PlaywrightMcpExecutor (production) and FakeBrowserExecutor
 * (deterministic, for handler/loop tests).
 */

export type BrowserSessionConfig = {
  runId: string;
  initialUrl: string;
  /** Exact origin every navigation must stay inside, e.g. https://app.example.com */
  allowedOrigin: string;
  viewport: { width: number; height: number };
  headless: boolean;
  defaultTimeoutMs: number;
  navigationTimeoutMs: number;
  /** Resolved secret values — worker memory only, never persisted. */
  secrets: ReadonlyMap<string, string>;
  /**
   * Previously captured browser storage-state JSON to inject before the
   * initial navigation (login session reuse). Decrypted worker-side; the
   * adapter must never persist it beyond a transient injection file.
   */
  storageStateJson?: string;
  signal: AbortSignal;
};

export type PageSnapshot = {
  /** Aria snapshot text with [ref=…] markers, as shown to the model. */
  text: string;
  url: string | null;
};

export type ActionObservation = {
  /** Milliseconds spent executing the action. */
  durationMs: number;
  /** Page URL after the action, when known. */
  url?: string;
  /** Free-form scrubbed detail (error text, verify output). */
  detail?: string;
};

export type ActionExecutionResult =
  | { status: "ok"; observation: ActionObservation }
  | {
      status: "failed";
      reason: "timeout" | "invalid_target" | "element_state" | "policy_violation";
      observation: ActionObservation;
    };

export interface BrowserExecutor {
  /** Launch the session and navigate to the initial URL. Throws on infra failure. */
  start(config: BrowserSessionConfig): Promise<void>;
  /** Current page accessibility snapshot; the model only ever sees this text. */
  takeSnapshot(): Promise<PageSnapshot>;
  /** Execute one validated agent action. Returns action outcomes; throws only on infra failure. */
  performAgentAction(action: AgentAction): Promise<ActionExecutionResult>;
  /** Capture a screenshot of the current page. */
  captureScreenshot(): Promise<{ bytes: Buffer; mimeType: string }>;
  /** Console error lines emitted since the last drain, scrubbed. */
  drainConsoleErrors(): Promise<string[]>;
  /**
   * Capture the current browser storage state (cookies/localStorage) for
   * encrypted reuse. Best-effort: returns null when capture is unavailable.
   */
  captureStorageState(): Promise<string | null>;
  /** Current page URL, when a page is open. */
  currentUrl(): Promise<string | null>;
  /** Idempotent teardown: close the session and kill the browser process tree. */
  dispose(): Promise<void>;
}

/** Thrown by executors for infrastructure failures the loop never feeds back. */
export class BrowserExecutorError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "BrowserExecutorError";
  }
}
