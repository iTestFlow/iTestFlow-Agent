"use client";

import { useEffect, useRef, useState } from "react";

import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DEFAULT_AUTO_UPDATE_CRON_EXPRESSION,
  validateCronExpression,
} from "@/modules/settings/cron-expression";
import {
  WEEKDAY_NAMES,
  buildDailyCron,
  buildMonthlyCron,
  buildWeeklyCron,
  describeCron,
  findNextCronRun,
  parseSchedule,
  parseTimeInputValue,
  toTimeInputValue,
} from "@/shared/lib/cron-schedule";
import { cn } from "@/lib/utils";
import type { ActiveProjectScope } from "@/shared/lib/active-project";
import type { FormState } from "./form-state";
import type { LatestAutoUpdateRun } from "./types";
import { Field } from "./section-card";
import { FilterMultiSelect } from "./filter-multi-select";

const DAY_OF_MONTH_OPTIONS = Array.from({ length: 28 }, (_, index) => index + 1);

export function ScheduledSyncSection({
  form,
  update,
  onToggleEnabled,
  scheduledProject,
  workItemTypeOptions,
  stateOptions,
  metadataLoading,
  metadataError,
  onRetryMetadata,
  latestRun,
}: {
  form: FormState;
  update: <K extends keyof FormState>(key: K, value: FormState[K]) => void;
  onToggleEnabled: (enabled: boolean) => void;
  scheduledProject: ActiveProjectScope | null;
  workItemTypeOptions: string[];
  stateOptions: string[];
  metadataLoading: boolean;
  metadataError: string | null;
  onRetryMetadata: () => void;
  latestRun: LatestAutoUpdateRun | null;
}) {
  const parsed = parseSchedule(form.autoUpdateCronExpression);
  const [forceCustom, setForceCustom] = useState(false);
  const mode: "daily" | "weekly" | "monthly" | "custom" = forceCustom || !parsed ? "custom" : parsed.mode;

  // Reset to the derived (preset) mode when the expression changes from outside
  // this component (e.g. Discard or a fresh load), while leaving the user's own
  // edits in Custom mode untouched.
  const lastWrittenCronRef = useRef(form.autoUpdateCronExpression);
  useEffect(() => {
    if (form.autoUpdateCronExpression !== lastWrittenCronRef.current) {
      lastWrittenCronRef.current = form.autoUpdateCronExpression;
      setForceCustom(false);
    }
  }, [form.autoUpdateCronExpression]);

  const time = parsed ? { hour: parsed.hour, minute: parsed.minute } : { hour: 2, minute: 0 };
  const dayOfWeek = parsed?.mode === "weekly" ? parsed.dayOfWeek : 1;
  const dayOfMonth = parsed?.mode === "monthly" ? parsed.dayOfMonth : 1;

  const cronError = form.autoUpdateEnabled ? validateCronExpression(form.autoUpdateCronExpression) : null;
  const nextRun = !cronError ? findNextCronRun(form.autoUpdateCronExpression) : null;
  const metadataReady = Boolean(scheduledProject);

  function setCron(expression: string) {
    lastWrittenCronRef.current = expression;
    update("autoUpdateCronExpression", expression);
  }

  function handleFrequencyChange(value: string) {
    if (value === "custom") {
      setForceCustom(true);
      return;
    }
    setForceCustom(false);
    if (value === "weekly") setCron(buildWeeklyCron(dayOfWeek, time.hour, time.minute));
    else if (value === "monthly") setCron(buildMonthlyCron(dayOfMonth, time.hour, time.minute));
    else setCron(buildDailyCron(time.hour, time.minute));
  }

  function handleTimeChange(value: string) {
    const next = parseTimeInputValue(value);
    if (!next) return;
    if (mode === "weekly") setCron(buildWeeklyCron(dayOfWeek, next.hour, next.minute));
    else if (mode === "monthly") setCron(buildMonthlyCron(dayOfMonth, next.hour, next.minute));
    else setCron(buildDailyCron(next.hour, next.minute));
  }

  return (
    <div className="space-y-5">
      <label className="flex items-start gap-3">
        <Checkbox
          checked={form.autoUpdateEnabled}
          onCheckedChange={(checked) => onToggleEnabled(checked === true)}
          className="mt-0.5"
          aria-label="Enable automatic sync"
        />
        <span>
          <span className="block text-sm font-medium text-foreground">Enable automatic sync</span>
          <span className="mt-1 block text-xs leading-5 text-muted-foreground">
            Runs on the local server for the selected Azure DevOps project using the filters configured here.
          </span>
        </span>
      </label>

      {form.autoUpdateEnabled ? (
        <div className="space-y-5 border-t border-border pt-5">
          <div
            className={cn(
              "rounded-md border p-3 text-xs",
              scheduledProject
                ? "border-primary/30 bg-primary/10 text-primary dark:text-primary"
                : "border-warning/40 bg-warning/15 text-warning-foreground dark:text-warning",
            )}
          >
            Scheduled project:{" "}
            {scheduledProject
              ? scheduledProject.azureProjectName
              : "Select an Azure DevOps project in the header before saving."}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Frequency" htmlFor="sync-frequency">
              <Select value={mode} onValueChange={handleFrequencyChange}>
                <SelectTrigger id="sync-frequency" className="h-11 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="daily">Daily</SelectItem>
                  <SelectItem value="weekly">Weekly</SelectItem>
                  <SelectItem value="monthly">Monthly</SelectItem>
                  <SelectItem value="custom">Custom (cron)</SelectItem>
                </SelectContent>
              </Select>
            </Field>

            {mode === "weekly" ? (
              <Field label="Day of week" htmlFor="sync-day-of-week">
                <Select
                  value={String(dayOfWeek)}
                  onValueChange={(value) => setCron(buildWeeklyCron(Number(value), time.hour, time.minute))}
                >
                  <SelectTrigger id="sync-day-of-week" className="h-11 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {WEEKDAY_NAMES.map((name, index) => (
                      <SelectItem key={name} value={String(index)}>
                        {name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            ) : null}

            {mode === "monthly" ? (
              <Field
                label="Day of month"
                htmlFor="sync-day-of-month"
                description="Capped at 28 so the sync runs every month."
              >
                <Select
                  value={String(dayOfMonth)}
                  onValueChange={(value) => setCron(buildMonthlyCron(Number(value), time.hour, time.minute))}
                >
                  <SelectTrigger id="sync-day-of-month" className="h-11 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DAY_OF_MONTH_OPTIONS.map((day) => (
                      <SelectItem key={day} value={String(day)}>
                        Day {day}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            ) : null}

            {mode !== "custom" ? (
              <Field label="Time" htmlFor="sync-time">
                <Input
                  id="sync-time"
                  type="time"
                  className="h-11 border-input bg-card text-foreground"
                  value={toTimeInputValue(time)}
                  onChange={(event) => handleTimeChange(event.target.value)}
                />
              </Field>
            ) : null}
          </div>

          {mode === "custom" ? (
            <Field
              label="Cron expression"
              htmlFor="sync-cron"
              description="Five fields: minute hour day-of-month month day-of-week. Example: 0 2 * * * runs daily at 2:00 AM."
            >
              <Input
                id="sync-cron"
                className="h-11 border-input bg-card font-mono text-foreground"
                value={form.autoUpdateCronExpression}
                onChange={(event) => setCron(event.target.value)}
                placeholder={DEFAULT_AUTO_UPDATE_CRON_EXPRESSION}
                aria-invalid={cronError ? true : undefined}
              />
              {cronError ? <p className="mt-2 text-xs leading-5 text-destructive">{cronError}</p> : null}
            </Field>
          ) : null}

          <p className="text-xs leading-5 text-muted-foreground">
            {describeCron(form.autoUpdateCronExpression)}
            {nextRun ? <> Next run: {formatDateTime(nextRun)}.</> : null}
          </p>

          <FilterMultiSelect
            title="Work item types"
            description="Work item types pulled into the project context on each sync."
            options={workItemTypeOptions}
            selectedValues={form.autoUpdateWorkItemTypes}
            onChange={(next) => update("autoUpdateWorkItemTypes", next)}
            loading={metadataLoading}
            error={metadataError}
            disabled={!metadataReady}
            searchPlaceholder="Search work item types"
            emptyMessage="No work item types were returned for this project."
            onRetry={onRetryMetadata}
            requireSelection
          />

          <FilterMultiSelect
            title="States"
            description="Work item states pulled into the project context on each sync."
            options={stateOptions}
            selectedValues={form.autoUpdateStates}
            onChange={(next) => update("autoUpdateStates", next)}
            loading={metadataLoading}
            error={metadataError}
            disabled={!metadataReady}
            searchPlaceholder="Search states"
            emptyMessage="No work item states were returned for this project."
            onRetry={onRetryMetadata}
            requireSelection
          />
        </div>
      ) : null}

      {latestRun ? <LatestRunSummary run={latestRun} /> : null}
    </div>
  );
}

function LatestRunSummary({ run }: { run: LatestAutoUpdateRun }) {
  const failed = /fail|error/i.test(run.status);
  return (
    <div className="rounded-md border border-border bg-muted/40 p-4 text-xs leading-6 text-muted-foreground">
      <div className="mb-1 flex items-center gap-2">
        <span className="font-medium text-foreground">Latest sync run</span>
        <span className={cn("font-medium", failed ? "text-destructive" : "text-success")}>{run.status}</span>
      </div>
      <p>Started: {formatDateTime(run.startedAt)}</p>
      <p>Completed: {formatDateTime(run.completedAt)}</p>
      <p>
        Indexed {run.contextIndexedWorkItemCount ?? 0} work items, {run.contextIndexedChunkCount ?? 0} chunks
        {" "}({run.contextCreatedCount ?? 0} created, {run.contextUpdatedCount ?? 0} updated,{" "}
        {run.contextUnchangedCount ?? 0} unchanged).
      </p>
      {run.knowledgeCompileStatus ? <p>Knowledge compile: {run.knowledgeCompileStatus}</p> : null}
      {run.errorDetails ? <p className="text-destructive">Error: {run.errorDetails}</p> : null}
    </div>
  );
}

function formatDateTime(value?: string | Date | null): string {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}
