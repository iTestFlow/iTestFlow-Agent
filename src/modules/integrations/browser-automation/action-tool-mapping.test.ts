import { describe, expect, it } from "vitest";

import type { AgentAction } from "@/modules/test-execution/action-schema";
import { planAgentAction } from "./action-tool-mapping";
import { ALLOWED_MCP_TOOLS } from "./mcp-tool-allowlist";

describe("planAgentAction", () => {
  it("maps ref-based element actions to allowlisted tools", () => {
    expect(
      planAgentAction({ type: "click", ref: "e5", elementDescription: "Save button" }),
    ).toEqual({ kind: "tool", tool: "browser_click", args: { target: "e5", element: "Save button" } });
    expect(
      planAgentAction({ type: "fill", ref: "e2", elementDescription: "Email", value: "a@b.c" }),
    ).toEqual({
      kind: "tool",
      tool: "browser_type",
      args: { target: "e2", element: "Email", text: "a@b.c" },
    });
    expect(
      planAgentAction({ type: "select", ref: "e3", elementDescription: "Country", value: "Egypt" }),
    ).toEqual({
      kind: "tool",
      tool: "browser_select_option",
      args: { target: "e3", element: "Country", values: ["Egypt"] },
    });
  });

  it("maps check/uncheck to state-aware toggles (no MCP check tool at 0.0.78)", () => {
    expect(planAgentAction({ type: "check", ref: "e1", elementDescription: "Terms" })).toEqual({
      kind: "toggle",
      ref: "e1",
      elementDescription: "Terms",
      desired: true,
    });
    expect(planAgentAction({ type: "uncheck", ref: "e1", elementDescription: "Terms" }).kind).toBe("toggle");
  });

  it("maps page-level actions", () => {
    expect(planAgentAction({ type: "navigate", url: "/orders" })).toEqual({
      kind: "tool",
      tool: "browser_navigate",
      args: { url: "/orders" },
    });
    expect(planAgentAction({ type: "pressKey", key: "Enter" })).toEqual({
      kind: "tool",
      tool: "browser_press_key",
      args: { key: "Enter" },
    });
    expect(planAgentAction({ type: "waitForText", text: "Welcome" })).toEqual({
      kind: "tool",
      tool: "browser_wait_for",
      args: { text: "Welcome" },
    });
    expect(planAgentAction({ type: "screenshot" })).toEqual({ kind: "screenshot" });
  });

  it("only ever emits allowlisted tool names", () => {
    const actions: AgentAction[] = [
      { type: "navigate", url: "/x" },
      { type: "click", ref: "e1", elementDescription: "x" },
      { type: "fill", ref: "e1", elementDescription: "x", value: "v" },
      { type: "select", ref: "e1", elementDescription: "x", value: "v" },
      { type: "check", ref: "e1", elementDescription: "x" },
      { type: "uncheck", ref: "e1", elementDescription: "x" },
      { type: "hover", ref: "e1", elementDescription: "x" },
      { type: "pressKey", key: "Tab" },
      { type: "waitForText", text: "x" },
      { type: "screenshot" },
    ];
    for (const action of actions) {
      const plan = planAgentAction(action);
      if (plan.kind === "tool") expect(ALLOWED_MCP_TOOLS).toContain(plan.tool);
    }
  });
});
