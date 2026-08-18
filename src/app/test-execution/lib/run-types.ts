import type { ScreenshotPolicy } from "@/modules/test-execution/screenshot-policy";

export type RunStatus = "queued" | "running" | "passed" | "failed" | "blocked" | "timeout" | "cancelled" | "error";

export type RunSummary = {
  id: string;
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
  executionNotes: string | null;
  screenshotPolicy: ScreenshotPolicy;
  testData?: Array<{ title: string; isSecret: boolean; value: string | null }>;
  publication?: RunPublication | null;
  cases: RunCase[];
  artifacts: RunArtifact[];
};

export type ExecutionProfileView = {
  id: string;
  name: string;
  baseUrl: string | null;
  executionNotes: string | null;
  screenshotPolicy: ScreenshotPolicy;
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
    case "running":
    case "queued": return "info";
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
};

export function runStatusLabel(status: RunStatus): string {
  return STATUS_LABELS[status] ?? status;
}
