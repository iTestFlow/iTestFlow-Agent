import type { RequirementFinding } from "@/components/workflow/test-intelligence-types";
import type { ProjectUser } from "@/types/azure-devops";

/* --------------------------------------------------------------------------
 * Pure helpers for the Requirements Analysis review/publish step. The mention
 * markup is injected at submit time, AFTER user review, so it must leave the
 * reviewed comment body itself untouched — any change here silently alters
 * what gets posted to Azure DevOps.
 * ------------------------------------------------------------------------ */

/** Sort key for findings review: critical first, unknown severities last. */
export function severityRank(value: RequirementFinding["severity"]) {
  const ranks: Record<RequirementFinding["severity"], number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
    info: 4,
  };
  return ranks[value] ?? 5;
}

/**
 * Prepends the Azure DevOps mention line (`@<userId>` markup, one token per
 * selected user, space-separated) followed by a blank line. With no mentions
 * the body is returned byte-identical; with mentions the body is trimmed but
 * its content (including any HTML/Markdown) is otherwise untouched.
 */
export function buildCommentBodyWithMentions(commentBody: string, mentionedUsers: ProjectUser[]) {
  if (!mentionedUsers.length) return commentBody;
  const mentionLine = mentionedUsers.map((user) => `@<${user.id}>`).join(" ");
  return `${mentionLine}\n\n${commentBody.trim()}`;
}
