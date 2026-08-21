import "server-only";

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ResolvedPlaywrightMcpConfig } from "./playwright-mcp-config.service";
import { assertAllowedPlaywrightTool, type PlaywrightToolClient } from "./playwright-agent";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

function allowNoSandbox(): boolean {
  if (process.env.PLAYWRIGHT_MCP_ALLOW_NO_SANDBOX !== "true") return false;
  return process.env.NODE_ENV !== "production" || process.env.PLAYWRIGHT_MCP_ALLOW_NO_SANDBOX_IN_PRODUCTION === "true";
}

function stripUnauthorizedSandboxArgs(args: readonly string[]): string[] {
  const stripped: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--no-sandbox" || arg.startsWith("--no-sandbox=")) continue;
    if (arg === "--sandbox" || arg.startsWith("--sandbox=")) continue;
    if (arg === "--config" || arg === "-c") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--config=") || arg.startsWith("-c=")) continue;
    stripped.push(arg);
  }
  return stripped;
}

function stdioSpawnEnv(noSandboxAllowed: boolean): Record<string, string> {
  const env: Record<string, string> = {};
  if (noSandboxAllowed && process.env.PLAYWRIGHT_MCP_NO_SANDBOX !== undefined) {
    env.PLAYWRIGHT_MCP_NO_SANDBOX = process.env.PLAYWRIGHT_MCP_NO_SANDBOX;
  }
  return env;
}

function deploymentStdioCommand(headless: boolean): { command: string; args: string[]; env: Record<string, string> } {
  const command = process.env.PLAYWRIGHT_MCP_STDIO_COMMAND?.trim();
  if (!command) throw new Error("PLAYWRIGHT_MCP_STDIO_COMMAND is not configured by the deployment.");
  const rawArgs = process.env.PLAYWRIGHT_MCP_STDIO_ARGS?.trim();
  const parsed = rawArgs ? JSON.parse(rawArgs) : [];
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
    throw new Error("PLAYWRIGHT_MCP_STDIO_ARGS must be a JSON array of strings.");
  }
  const noSandboxAllowed = allowNoSandbox();
  const args = stripDeploymentOutputDirArgs(noSandboxAllowed ? [...parsed] : stripUnauthorizedSandboxArgs(parsed));
  // The only per-run influence on the spawn is this hard-coded literal flag —
  // deployment args stay authoritative and user input never reaches argv.
  if (headless && !args.includes("--headless")) args.push("--headless");
  if (!noSandboxAllowed) args.push("--sandbox");
  return { command, args, env: stdioSpawnEnv(noSandboxAllowed) };
}

function stripDeploymentOutputDirArgs(args: readonly string[]): string[] {
  const stripped: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--output-dir") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--output-dir=")) continue;
    stripped.push(arg);
  }
  return stripped;
}

function withoutTopLevelFilename(inputSchema: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!inputSchema) return {};
  const properties = inputSchema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties) || !("filename" in properties)) return inputSchema;
  const { filename: _filename, ...safeProperties } = properties as Record<string, unknown>;
  const required = Array.isArray(inputSchema.required)
    ? inputSchema.required.filter((name) => name !== "filename")
    : inputSchema.required;
  return { ...inputSchema, properties: safeProperties, ...(required === undefined ? {} : { required }) };
}

function withoutModelFilename(args: Record<string, unknown>): Record<string, unknown> {
  const { filename: _filename, ...safeArgs } = args;
  return safeArgs;
}

function waitForStdioClose(closed: Promise<void>): Promise<void> {
  return Promise.race([
    closed,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Playwright MCP stdio transport did not close.")), 2_000).unref()),
  ]);
}

const noRedirectFetch: typeof fetch = (url, init) => fetch(url, { ...init, redirect: "error" });

function parseOpenTabUrls(result: CallToolResult): string[] {
  if (result.isError || result.content.length !== 1 || result.content[0]?.type !== "text") {
    throw new Error("Playwright browser tab state could not be verified.");
  }
  const text = result.content[0].text;
  const sections = new Map<string, string>();
  for (const chunk of text.split(/^### /m).slice(1)) {
    const newline = chunk.indexOf("\n");
    if (newline > 0) {
      const name = chunk.slice(0, newline);
      if (sections.has(name)) throw new Error("Playwright browser tab state could not be verified.");
      sections.set(name, chunk.slice(newline + 1).trim());
    }
  }
  const tabSections = [sections.get("Result"), sections.get("Open tabs")]
    .filter((section): section is string => section !== undefined);
  if (!tabSections.length) throw new Error("Playwright browser tab state could not be verified.");
  const parsed = tabSections.map(parseTabSection);
  if (parsed.some((urls) => JSON.stringify(urls) !== JSON.stringify(parsed[0]))) {
    throw new Error("Playwright browser tab state could not be verified.");
  }
  return parsed[0];
}

function parseTabSection(section: string): string[] {
  if (section === "No open tabs. Navigate to a URL to create one.") return [];
  const urls: string[] = [];
  for (const line of section.split("\n")) {
    const match = line.match(/^- \d+:(?: \(current\))? \[.*\]\((.*)\)(?: \[crashed\])?$/);
    if (!match?.[1]) throw new Error("Playwright browser tab state could not be verified.");
    urls.push(match[1]);
  }
  if (!urls.length) throw new Error("Playwright browser tab state could not be verified.");
  return urls;
}

export async function connectPlaywrightMcp(config: ResolvedPlaywrightMcpConfig, options?: { headless?: boolean }): Promise<{
  tools: PlaywrightToolClient;
  close: () => Promise<void>;
}> {
  if (config.status !== "configured" || !config.transport) throw new Error("Playwright MCP is not enabled.");
  const stdioCommand = config.transport === "stdio" ? deploymentStdioCommand(options?.headless ?? true) : undefined;
  let runtimeDir: string | undefined;
  if (stdioCommand) runtimeDir = await mkdtemp(path.join(tmpdir(), "itestflow-playwright-mcp-"));
  const clientTransport = config.transport === "http"
    ? new StreamableHTTPClientTransport(new URL(config.endpoint!), {
        fetch: noRedirectFetch,
        requestInit: {
          redirect: "error",
          ...(config.bearerToken ? { headers: { Authorization: `Bearer ${config.bearerToken}` } } : {}),
        },
    })
    : new StdioClientTransport({ ...stdioCommand!, args: [...stdioCommand!.args, "--output-dir", runtimeDir!], cwd: runtimeDir });
  const stdioClosed = runtimeDir
    ? new Promise<void>((resolve) => {
      clientTransport.onclose = resolve;
    })
    : undefined;
  const client = new Client({ name: "itestflow-agent", version: "0.1.0" });
  let closePromise: Promise<void> | undefined;
  const closeConnection = () => {
    closePromise ??= (async () => {
      try {
        await client.close();
      } finally {
        if (runtimeDir && stdioClosed) {
          await waitForStdioClose(stdioClosed);
          await rm(runtimeDir, { recursive: true, force: true });
        }
      }
    })();
    return closePromise;
  };
  const timeout = AbortSignal.timeout(15_000);
  try {
    await Promise.race([
      client.connect(clientTransport),
      new Promise<never>((_, reject) => timeout.addEventListener("abort", () => reject(new Error("Playwright MCP connection timed out.")), { once: true })),
    ]);
    const available = await client.listTools(undefined, { signal: timeout });
  const approved = new Set(available.tools.map((tool) => tool.name).filter((name) => {
    try { assertAllowedPlaywrightTool(name); return true; } catch { return false; }
  }));
  const toolDefinitions = available.tools
    .filter((tool) => approved.has(tool.name))
    .map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: withoutTopLevelFilename(tool.inputSchema as Record<string, unknown> | undefined),
    }));
  for (const required of ["browser_navigate", "browser_snapshot", "browser_tabs"]) {
      if (!approved.has(required)) {
        throw new Error(`Playwright MCP server is missing required tool "${required}".`);
    }
  }
    return {
    tools: {
      toolDefinitions,
      async callTool(name, args, signal) {
        assertAllowedPlaywrightTool(name);
        if (!approved.has(name)) throw new Error(`Playwright MCP server does not advertise tool "${name}".`);
        return client.callTool({ name, arguments: withoutModelFilename(args) }, undefined, { signal });
      },
      async listOpenTabs(signal) {
        const result = await client.callTool(
          { name: "browser_tabs", arguments: { action: "list" } }, undefined, { signal },
        ) as CallToolResult;
        return parseOpenTabUrls(result);
      },
    },
    close: closeConnection,
    };
  } catch (error) {
    await closeConnection().catch(() => undefined);
    throw error;
  }
}
