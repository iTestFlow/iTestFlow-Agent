import "server-only";

import {
  requireWorkflowContext,
  requireWorkflowRole,
} from "@/modules/credentials/scoped-resolution.service";

/** Egress rules are a workspace-level security boundary: owners/admins only. */
export async function requireEgressAdmin(workspaceId: string) {
  const ctx = await requireWorkflowContext(workspaceId);
  await requireWorkflowRole(
    ctx,
    ["owner", "admin"],
    "Only workspace owners and admins can manage test-execution egress rules.",
  );
  return ctx;
}
