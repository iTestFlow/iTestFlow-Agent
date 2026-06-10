import type { DashboardRecentActivity } from "./dashboard";

export type ActivityLogActionOption = {
  value: string;
  label: string;
};

export type ActivityLogResult = {
  generatedAt: string;
  items: DashboardRecentActivity[];
  hasMore: boolean;
  availableActions: ActivityLogActionOption[];
};
