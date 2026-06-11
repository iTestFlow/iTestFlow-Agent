import type { ActiveProjectScope } from "@/shared/lib/active-project";

export type Provider = "openai" | "gemini" | "anthropic" | "ollama";

export type ServiceTestResult = { success: boolean; error?: string };

export type TestResult = {
  success: boolean;
  azureDevOps: ServiceTestResult;
  llm: ServiceTestResult;
};

/** Which Azure / LLM service a per-section test action surfaces. */
export type TestService = "azureDevOps" | "llm";

/** Visual tone for a status badge, mapped to the design-system color tokens. */
export type StatusTone = "success" | "warning" | "destructive" | "muted" | "info";

export type StatusValue = {
  tone: StatusTone;
  label: string;
  detail?: string;
};

/** Shape of the latest scheduled-sync run surfaced from the runtime summary. */
export type LatestAutoUpdateRun = {
  status: string;
  startedAt: string;
  completedAt?: string | null;
  cronTimezone?: string;
  errorDetails?: string | null;
  contextIndexedWorkItemCount?: number;
  contextIndexedChunkCount?: number;
  contextCreatedCount?: number;
  contextUpdatedCount?: number;
  contextUnchangedCount?: number;
  contextInactiveCount?: number;
  contextSkippedEmptyCount?: number;
  knowledgeSourceWorkItemCount?: number;
  knowledgeCompileStatus?: string;
  knowledgeCompileMode?: string | null;
  knowledgeCompileSkippedReason?: string | null;
};

export type { ActiveProjectScope };
