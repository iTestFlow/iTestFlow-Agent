import "server-only";

import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { BrowserExecutorError } from "./browser-executor.port";

/**
 * Child-process lifecycle for @playwright/mcp@0.0.78 (exact pin).
 *
 * One MCP server process per run, spawned over stdio with an isolated
 * in-memory browser profile. The --secrets flag is deliberately NOT used: it
 * would require writing plaintext secret files to disk; redaction is owned by
 * output-scrubber instead. --allowed-origins is also not passed — it would
 * block the app-under-test's own CDN subresources; navigation-origin policy
 * is enforced per action by the executor and plan validation.
 */

const KILL_ESCALATION_MS = 500;

export type McpProcessConfig = {
  runId: string;
  headless: boolean;
  viewport: { width: number; height: number };
  actionTimeoutMs: number;
  navigationTimeoutMs: number;
};

export type McpSession = {
  client: Client;
  pid: number | null;
  outputDir: string;
  close: () => Promise<void>;
};

function resolveMcpCliPath(): string {
  const require = createRequire(import.meta.url);
  const packageJsonPath = require.resolve("@playwright/mcp/package.json");
  return path.join(path.dirname(packageJsonPath), "cli.js");
}

export function executionTempRoot(): string {
  return path.join(process.cwd(), "data", "tmp", "test-execution");
}

export function buildMcpArgs(config: McpProcessConfig, outputDir: string): string[] {
  const args = [
    resolveMcpCliPath(),
    "--isolated",
    "--caps=testing",
    "--browser=chromium",
    `--viewport-size=${config.viewport.width}x${config.viewport.height}`,
    `--timeout-action=${config.actionTimeoutMs}`,
    `--timeout-navigation=${config.navigationTimeoutMs}`,
    `--output-dir=${outputDir}`,
  ];
  if (config.headless) args.push("--headless");
  return args;
}

export async function startMcpSession(config: McpProcessConfig): Promise<McpSession> {
  const outputDir = path.join(
    executionTempRoot(),
    `${config.runId}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
  );
  await mkdir(outputDir, { recursive: true });

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: buildMcpArgs(config, outputDir),
    env: { ...process.env } as Record<string, string>,
    stderr: "ignore",
  });
  const client = new Client({ name: "itestflow-test-execution", version: "1.0.0" });

  try {
    await client.connect(transport);
  } catch (error) {
    await transport.close().catch(() => undefined);
    await rm(outputDir, { recursive: true, force: true }).catch(() => undefined);
    throw new BrowserExecutorError("Failed to start the Playwright MCP server process.", error);
  }

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    const pid = transport.pid;
    // Graceful first: closing the transport ends stdin, which the MCP server
    // treats as shutdown (it closes its browser). Escalate quickly — the
    // worker's shutdown grace budget is 3 seconds total.
    await client.close().catch(() => undefined);
    if (pid) {
      await new Promise((resolve) => setTimeout(resolve, KILL_ESCALATION_MS));
      killProcessTree(pid);
    }
    await rm(outputDir, { recursive: true, force: true }).catch(() => undefined);
  };

  return { client, pid: transport.pid ?? null, outputDir, close };
}

/** Hard-kill a process tree; tolerant of already-exited processes. */
export function killProcessTree(pid: number): void {
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", detached: false });
    } else {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        return;
      }
      setTimeout(() => {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
      }, KILL_ESCALATION_MS).unref();
    }
  } catch {
    // Process already exited — nothing to do.
  }
}

/**
 * Worker-startup reaper: at boot no runs are active on this worker, so every
 * leftover per-run temp dir is an orphan from a crash or hard shutdown.
 */
export async function reapOrphanExecutionTempDirs(): Promise<void> {
  await rm(executionTempRoot(), { recursive: true, force: true }).catch(() => undefined);
}
