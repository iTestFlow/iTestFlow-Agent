"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
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

  return (
    <div className="space-y-5 p-4">
      <div className="grid gap-3 md:grid-cols-2">
        <ToggleRow
          label="Enable workflow feedback prompts"
          description="Allow users to rate completed workflow outputs."
          checked={settings.feedbackPromptEnabled}
          onCheckedChange={(feedbackPromptEnabled) => patch({ feedbackPromptEnabled })}
        />
      </div>

      <div>
        <div className="text-sm font-semibold text-foreground">Manual baseline minutes</div>
        <p className="mt-1 text-xs text-muted-foreground">Used only for transparent Estimated time-saving calculations.</p>
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

function ToggleRow({
  label,
  description,
  checked,
  onCheckedChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-3">
      <div>
        <div className="text-sm font-medium text-foreground">{label}</div>
        <div className="mt-1 text-xs leading-5 text-muted-foreground">{description}</div>
      </div>
      <Switch checked={checked} onCheckedChange={onCheckedChange} aria-label={label} />
    </div>
  );
}
