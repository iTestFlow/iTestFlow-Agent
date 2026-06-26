import { Activity } from "lucide-react";

import type { SystemDashboardAnalytics } from "@/types/system-dashboard";

export type AdoptionMetricItem = [string, string | number | null, string, typeof Activity];

export function adoptionActivityMetric(
  data: Pick<SystemDashboardAnalytics, "adoption" | "effectiveScope">,
): AdoptionMetricItem {
  if (data.effectiveScope.mode === "team") {
    return ["Active Users", data.adoption.activeUsers, "Distinct recorded workflow users.", Activity];
  }
  return ["Active Days", data.adoption.activeDays, "Days with at least one recorded workflow run.", Activity];
}
