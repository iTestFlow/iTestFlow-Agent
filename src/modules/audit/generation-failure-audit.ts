import "server-only";

import { isTruncationErrorMessage } from "@/modules/llm/llm-warnings";
import { assertProjectScope, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import { writeAuditLog } from "./audit.service";

// Records a failed AI generation in the activity log (audit_logs). Generation services only write
// audit entries on success, so without this a failed run — including truncation — is invisible on
// the Activity Log page. Call this from a generation route's catch block before returning the
// error response. Truncation failures get a flag and an actionable message so they stand out.
export function writeGenerationFailureAudit(input: {
  scope: ProjectScope;
  action: string;
  /** Human-readable label for the failed operation, e.g. "Test case generation failed." */
  label: string;
  error: unknown;
}) {
  const errorMessage = input.error instanceof Error ? input.error.message : String(input.error);
  const truncated = isTruncationErrorMessage(errorMessage);
  const message = truncated
    ? `${input.label} Output hit the "Maximum output token cap" before completing — increase it in Settings and retry.`
    : input.label;

  let scope: ProjectScope;
  try {
    scope = assertProjectScope(input.scope);
  } catch {
    // Scope was already validated upstream; if it somehow isn't, skip the audit rather than
    // mask the original generation error with a logging failure.
    return;
  }

  try {
    writeAuditLog({
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      azureProjectName: scope.azureProjectName,
      azureOrganizationUrl: scope.azureOrganizationUrl,
      action: input.action,
      status: "Failed",
      message,
      details: {
        error: errorMessage,
        ...(truncated ? { truncated: true } : {}),
      },
    });
  } catch (logError) {
    console.error("Failed to write generation failure audit log", logError);
  }
}
