"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  defaultWorkflowBaselines,
  workflowLabels,
  workflowTypeValues,
  type WorkflowType,
} from "@/modules/analytics/analytics-config";
import type { FormState } from "./form-state";

export function DashboardValueMetricsSection({
  form,
  update,
}: {
  form: FormState;
  update: <K extends keyof FormState>(key: K, value: FormState[K]) => void;
}) {
  const settings = form.dashboardValueMetrics;

  function patch(next: Partial<FormState["dashboardValueMetrics"]>) {
    update("dashboardValueMetrics", { ...settings, ...next });
  }

  function updateBaseline(workflowType: WorkflowType, value: string) {
    const parsed = Number(value);
    patch({
      manualBaselineMinutes: {
        ...settings.manualBaselineMinutes,
        [workflowType]: Number.isFinite(parsed) ? Math.max(0, parsed) : 0,
      },
    });
  }

  function resetToDefaults() {
    patch({ manualBaselineMinutes: { ...defaultWorkflowBaselines } });
  }

  return (
    <div className="space-y-5">
      <div>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-foreground">Manual baseline minutes</div>
            <p className="mt-1 text-xs text-muted-foreground">
              Used only for transparent estimated time-saving calculations.
            </p>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={resetToDefaults}>
            Reset to recommended defaults
          </Button>
        </div>
        <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {workflowTypeValues.map((workflowType) => (
            <div key={workflowType} className="space-y-1.5">
              <Label htmlFor={`baseline-${workflowType}`} className="text-xs">{workflowLabels[workflowType]}</Label>
              <Input
                id={`baseline-${workflowType}`}
                type="number"
                min="0"
                max="1440"
                value={settings.manualBaselineMinutes[workflowType]}
                onChange={(event) => updateBaseline(workflowType, event.target.value)}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
