import type { AzureAuthenticatedUser } from "@/modules/integrations/azure-devops/azure-devops-types";

export type WorkbenchSprintMode =
  | "current"
  | "previous"
  | "next"
  | "all_active"
  | "custom"
  | "overall";

export type WorkbenchStatusGroup =
  | "To Do"
  | "Active"
  | "Blocked / Waiting"
  | "Review / Testing"
  | "Done"
  | "Other / Unmapped";

export type WorkbenchRiskStatus = "On Track" | "At Risk" | "Behind" | "No Estimate" | "Planned" | "Needs Estimate" | "No Sprint";

export type WorkbenchFilters = {
  sprintMode: WorkbenchSprintMode;
  iterationPath: string | null;
  workItemTypes: string[];
  statusGroups: WorkbenchStatusGroup[];
  priority: "all" | "1" | "2" | "3" | "4" | "none";
  areaPath: string | null;
  includeCompleted: boolean;
  includeBacklog: boolean;
};

export type WorkbenchFilterOption = {
  value: string;
  label: string;
  description?: string;
};

export type WorkbenchFilterMetadata = {
  iterations: Array<WorkbenchFilterOption & { startDate?: string; finishDate?: string; category?: "current" | "previous" | "next" | "active" | "past" | "future" }>;
  areas: WorkbenchFilterOption[];
  workItemTypes: WorkbenchFilterOption[];
  statusGroups: Array<WorkbenchFilterOption & { value: WorkbenchStatusGroup }>;
};

export type WorkbenchCard = {
  key: "focusNow" | "remainingWork" | "sprintProgress" | "blockedWaiting" | "atRisk" | "unestimatedWork";
  title: string;
  value: string;
  subtitle: string;
  tone: "blue" | "green" | "yellow" | "red" | "purple" | "neutral";
};

export type WorkbenchFocusBadge =
  | "Blocked"
  | "Overdue"
  | "Due Soon"
  | "High Priority"
  | "No Estimate"
  | "Current Sprint"
  | "At Risk"
  | "Unmapped State";

export type WorkbenchFocusItem = {
  id: string;
  title: string;
  url: string | null;
  focusScore: number;
  focusBadges: WorkbenchFocusBadge[];
  type: string;
  state: string;
  status: WorkbenchStatusGroup;
  parent: { id: string; title: string; url: string | null } | null;
  sprint: string | null;
  remainingWork: number | null;
  completedWork: number | null;
  originalEstimate: number | null;
  priority: number | null;
  dueDate: string | null;
  sprintEndDate: string | null;
  tags: string[];
  blockerSummary: string | null;
  changedDate: string | null;
};

export type WorkbenchSprintRow = {
  sprint: string;
  items: number;
  remainingWork: number | null;
  completedWork: number | null;
  blocked: number;
  unestimated: number;
  status: WorkbenchRiskStatus;
};

export type WorkbenchDistributionDatum = {
  name: string;
  value: number;
  key?: string;
};

export type WorkbenchBurnPoint = {
  date: string;
  idealRemaining: number;
  actualRemaining?: number;
};

export type MyWorkbenchAnalytics = {
  generatedAt: string;
  user: AzureAuthenticatedUser;
  filters: WorkbenchFilters;
  filterMetadata: WorkbenchFilterMetadata;
  cards: WorkbenchCard[];
  focusList: WorkbenchFocusItem[];
  assignedBySprint: WorkbenchSprintRow[];
  charts: {
    remainingWorkByStatus: WorkbenchDistributionDatum[];
    sprintBurnStatus: WorkbenchBurnPoint[];
    workItemsByType: WorkbenchDistributionDatum[];
  };
  metadata: {
    selectedSprint: {
      mode: WorkbenchSprintMode;
      path: string | null;
      startDate: string | null;
      finishDate: string | null;
    };
    counts: {
      assigned: number;
      scoped: number;
      filtered: number;
      completedExcluded: number;
      tableRows: number;
    };
    warnings: string[];
  };
};
