import "server-only";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ResolvedPlaywrightMcpConfig } from "./playwright-mcp-config.service";
import { assertAllowedPlaywrightTool, type PlaywrightToolClient } from "./playwright-agent";

function deploymentStdioCommand(): { command: string; args: string[] } {
  const command = process.env.PLAYWRIGHT_MCP_STDIO_COMMAND?.trim();
  if (!command) throw new Error("PLAYWRIGHT_MCP_STDIO_COMMAND is not configured by the deployment.");
  const rawArgs = process.env.PLAYWRIGHT_MCP_STDIO_ARGS?.trim();
  const args = rawArgs ? JSON.parse(rawArgs) : [];
  if (!Array.isArray(args) || args.some((value) => typeof value !== "string")) {
    throw new Error("PLAYWRIGHT_MCP_STDIO_ARGS must be a JSON array of strings.");
  }
  return { command, args };
}

const noRedirectFetch: typeof fetch = (url, init) => fetch(url, { ...init, redirect: "error" });

export async function connectPlaywrightMcp(config: ResolvedPlaywrightMcpConfig): Promise<{
  tools: PlaywrightToolClient;
  close: () => Promise<void>;
}> {
  if (config.status !== "configured" || !config.transport) throw new Error("Playwright MCP is not enabled.");
  const transport = config.transport === "http"
    ? new StreamableHTTPClientTransport(new URL(config.endpoint!), {
        fetch: noRedirectFetch,
        requestInit: {
          redirect: "error",
          ...(config.bearerToken ? { headers: { Authorization: `Bearer ${config.bearerToken}` } } : {}),
        },
      })
    : new StdioClientTransport(deploymentStdioCommand());
  const client = new Client({ name: "itestflow-agent", version: "0.1.0" });
  const timeout = AbortSignal.timeout(15_000);
  try {
    await Promise.race([
      client.connect(transport),
      new Promise<never>((_, reject) => timeout.addEventListener("abort", () => reject(new Error("Playwright MCP connection timed out.")), { once: true })),
    ]);
    const available = await client.listTools(undefined, { signal: timeout });
  const approved = new Set(available.tools.map((tool) => tool.name).filter((name) => {
    try { assertAllowedPlaywrightTool(name); return true; } catch { return false; }
  }));
  for (const required of ["browser_navigate", "browser_snapshot"]) {
    if (!approved.has(required)) {
      await client.close();
      throw new Error(`Playwright MCP server is missing required tool "${required}".`);
    }
  }
    return {
    tools: {
      async callTool(name, args, signal) {
        assertAllowedPlaywrightTool(name);
        if (!approved.has(name)) throw new Error(`Playwright MCP server does not advertise tool "${name}".`);
        return client.callTool({ name, arguments: args }, undefined, { signal });
      },
    },
    close: () => client.close(),
    };
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}
