import type { ScreenshotPolicy } from "@/modules/test-execution/screenshot-policy";
import type { ConnectionView, StepPhase } from "@/modules/test-execution/execution-connections.shared";

export type InstructionSnippet = { id: string; name: string; instructions: string; expectedResult: string | null };

export type RunOperation = {
  id: string;
  connectionAlias?: string | null;
  alias?: string | null;
  layer?: "browser" | "api" | "database" | null;
  toolName?: string | null;
  operation?: string | null;
  status?: RunStatus;
  durationMs?: number | null;
  assertion?: string | null;
  errorMessage?: string | null;
};

export type RunStatus = "queued" | "running" | "passed" | "failed" | "blocked" | "timeout" | "cancelled" | "error" | "skipped";

export type RunSummary = {
  id: string;
  name?: string | null;
  status: RunStatus;
  totalCases: number;
  completedCases: number;
  createdAt: string;
  errorMessage?: string | null;
  azurePlanId: number | null;
  azureSuiteId: number | null;
};

export type RunStep = {
  id: string;
  index: number;
  action: string;
  phase?: StepPhase;
  layer?: "browser" | "api" | "database" | null;
  operations?: RunOperation[];
  expectedResult: string | null;
  status: RunStatus;
  toolName: string | null;
  errorMessage: string | null;
};

export type RunCase = {
  id: string;
  azureTestCaseId: number | null;
  azureTestPointId: number | null;
  azurePlanId?: number | null;
  azureSuiteId?: number | null;
  title: string;
  status: RunStatus;
  errorMessage: string | null;
  steps: RunStep[];
};

export type RunArtifact = {
  id: string;
  caseId: string | null;
  stepId: string | null;
  kind: string;
  mimeType: string;
  byteSize: number;
};

export type RunPublication = {
  status: "running" | "completed" | "partial" | "failed";
  published: number;
  total: number;
  finishedAt: string | null;
};

export type RunDetail = RunSummary & {
  baseUrl: string | null;
  browserEnabled?: boolean;
  connections?: ConnectionView[];
  executionNotes: string | null;
  screenshotPolicy: ScreenshotPolicy;
  headless?: boolean;
  viewportWidth?: number;
  viewportHeight?: number;
  testData?: Array<{ title: string; isSecret: boolean; value: string | null }>;
  publication?: RunPublication | null;
  cases: RunCase[];
  artifacts: RunArtifact[];
};

export type ExecutionProfileView = {
  id: string;
  name: string;
  baseUrl: string | null;
  browserEnabled?: boolean;
  connections?: ConnectionView[];
  executionNotes: string | null;
  screenshotPolicy: ScreenshotPolicy;
  headless: boolean;
  viewportWidth: number;
  viewportHeight: number;
  testData: Array<{ title: string; isSecret: boolean; value: string | null }>;
  updatedAt: string;
};

export function isLiveRunStatus(status: RunStatus): boolean {
  return status === "queued" || status === "running";
}

export function runStatusTone(status: RunStatus): "success" | "warning" | "error" | "info" | "neutral" {
  switch (status) {
    case "passed": return "success";
    case "failed":
    case "error": return "error";
    case "blocked":
    case "timeout": return "warning";
    case "running": return "info";
    case "queued":
    case "skipped": return "neutral";
    default: return "neutral";
  }
}

const STATUS_LABELS: Record<RunStatus, string> = {
  queued: "Queued",
  running: "Running",
  passed: "Passed",
  failed: "Failed",
  blocked: "Blocked",
  timeout: "Timed out",
  cancelled: "Cancelled",
  error: "Error",
  skipped: "Skipped",
};

export function runStatusLabel(status: RunStatus): string {
  return STATUS_LABELS[status] ?? status;
}
