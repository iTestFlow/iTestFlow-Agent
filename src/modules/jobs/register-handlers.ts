import "server-only";

import { registerJobHandler } from "./job-handlers";
import { runWorkspaceContextSync, WORKSPACE_CONTEXT_SYNC } from "./workspace-sync.handler";

let registered = false;

/** Registers all job handlers exactly once. Called by the worker at startup. */
export function registerAllJobHandlers(): void {
  if (registered) return;
  registerJobHandler(WORKSPACE_CONTEXT_SYNC, runWorkspaceContextSync);
  registered = true;
}
