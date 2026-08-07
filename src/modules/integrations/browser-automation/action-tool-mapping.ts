/**
 * Pure mapping from validated agent actions to Playwright MCP tool
 * invocations (@playwright/mcp@0.0.78, grounded against the installed
 * bundle). Element targeting is the snapshot ref the model chose and the
 * validator confirmed. check/uncheck have no MCP tools at this version
 * (skillOnly) — the adapter handles them as snapshot-state-aware clicks, so
 * this module maps them to a `toggle` plan.
 */

import type { AgentAction } from "@/modules/test-execution/action-schema";
import type { AllowedMcpTool } from "./mcp-tool-allowlist";

export type AgentActionPlan =
  | { kind: "tool"; tool: AllowedMcpTool; args: Record<string, unknown> }
  | { kind: "toggle"; ref: string; elementDescription: string; desired: boolean }
  | { kind: "screenshot" };

export function planAgentAction(action: AgentAction): AgentActionPlan {
  switch (action.type) {
    case "navigate":
      return { kind: "tool", tool: "browser_navigate", args: { url: action.url } };
    case "click":
      return {
        kind: "tool",
        tool: "browser_click",
        args: { target: action.ref, element: action.elementDescription },
      };
    case "hover":
      return {
        kind: "tool",
        tool: "browser_hover",
        args: { target: action.ref, element: action.elementDescription },
      };
    case "fill":
      return {
        kind: "tool",
        tool: "browser_type",
        args: { target: action.ref, element: action.elementDescription, text: action.value },
      };
    case "select":
      return {
        kind: "tool",
        tool: "browser_select_option",
        args: { target: action.ref, element: action.elementDescription, values: [action.value] },
      };
    case "check":
      return { kind: "toggle", ref: action.ref, elementDescription: action.elementDescription, desired: true };
    case "uncheck":
      return { kind: "toggle", ref: action.ref, elementDescription: action.elementDescription, desired: false };
    case "pressKey":
      return { kind: "tool", tool: "browser_press_key", args: { key: action.key } };
    case "waitForText":
      return { kind: "tool", tool: "browser_wait_for", args: { text: action.text } };
    case "screenshot":
      return { kind: "screenshot" };
  }
}
