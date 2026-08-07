/**
 * MCP tool allowlist for @playwright/mcp@0.0.78 (exact pin).
 *
 * Grounded against the installed bundle (playwright-core/lib/coreBundle.js):
 * - Tools marked skillOnly (browser_check, browser_uncheck, browser_reload,
 *   browser_keydown/up, ...) are NOT exposed over MCP tools/list at this
 *   version; check/uncheck are implemented as snapshot-state-aware clicks.
 * - Element targeting is the `target` field: a snapshot ref (e.g. "e12") or a
 *   unique element selector.
 * - Assertions require the server to run with --caps=testing.
 *
 * Anything not listed here is unreachable by construction: the action-tool
 * mapping only emits these names, and the executor rejects any other name at
 * call time. browser_evaluate, browser_run_code_unsafe, browser_file_upload,
 * storage/cookie/route/tab/mouse-xy tools are deliberately absent.
 */

export const ALLOWED_MCP_TOOLS = [
  "browser_navigate",
  "browser_click",
  "browser_type",
  "browser_select_option",
  "browser_hover",
  "browser_press_key",
  "browser_wait_for",
  "browser_snapshot",
  "browser_take_screenshot",
  "browser_console_messages",
  "browser_verify_element_visible",
  "browser_verify_text_visible",
  "browser_verify_value",
] as const;

export type AllowedMcpTool = (typeof ALLOWED_MCP_TOOLS)[number];

export function isAllowedMcpTool(name: string): name is AllowedMcpTool {
  return (ALLOWED_MCP_TOOLS as readonly string[]).includes(name);
}

/**
 * Session-start capability check: every tool we plan to call must be present
 * in the server's tools/list. A missing tool means the pinned package drifted
 * and the run must fail fast as infrastructure_error, never mid-case.
 */
export function findMissingMcpTools(advertisedToolNames: readonly string[]): string[] {
  return ALLOWED_MCP_TOOLS.filter((tool) => !advertisedToolNames.includes(tool));
}
