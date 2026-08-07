import { describe, expect, it } from "vitest";

import { ALLOWED_MCP_TOOLS, findMissingMcpTools, isAllowedMcpTool } from "./mcp-tool-allowlist";

describe("mcp tool allowlist", () => {
  it("never contains the dangerous tools", () => {
    for (const banned of [
      "browser_evaluate",
      "browser_run_code_unsafe",
      "browser_file_upload",
      "browser_tabs",
      "browser_set_storage_state",
      "browser_mouse_click_xy",
    ]) {
      expect(ALLOWED_MCP_TOOLS).not.toContain(banned);
      expect(isAllowedMcpTool(banned)).toBe(false);
    }
  });

  it("accepts allowlisted names", () => {
    expect(isAllowedMcpTool("browser_click")).toBe(true);
    expect(isAllowedMcpTool("browser_snapshot")).toBe(true);
  });

  it("findMissingMcpTools reports drift against the advertised tool list", () => {
    expect(findMissingMcpTools([...ALLOWED_MCP_TOOLS])).toEqual([]);
    const withoutVerify = ALLOWED_MCP_TOOLS.filter((tool) => tool !== "browser_verify_value");
    expect(findMissingMcpTools(withoutVerify)).toEqual(["browser_verify_value"]);
  });
});
