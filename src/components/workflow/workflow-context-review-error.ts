import { ApiError } from "@/components/workflow/api-error";

/** True when a frozen review must be rebuilt before a workflow can continue. */
export function isContextReviewRefreshRequired(error: unknown) {
  if (!(error instanceof ApiError) || !error.payload || typeof error.payload !== "object") return false;
  return (error.payload as { code?: unknown }).code === "CONTEXT_REVIEW_REQUIRED";
}
