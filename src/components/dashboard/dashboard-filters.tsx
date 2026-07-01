"use client";

import { Filter, X } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SearchableCombobox } from "@/components/ui/searchable-combobox";
import { SearchableMultiSelect } from "@/components/ui/searchable-multi-select";
import type { DashboardDatePreset, DashboardFilterMetadata, DashboardFilters } from "@/types/dashboard";

export type DashboardFilterState = {
  datePreset: DashboardDatePreset;
  from: string;
  to: string;
  testPlanId: string | null;
  testSuiteIds: string[];
  areaPath: string | null;
  iterationPath: string | null;
  workItemTypes: string[];
  assignee: string | null;
};

export const defaultDashboardFilters: DashboardFilterState = {
  datePreset: "current_sprint",
  from: "",
  to: "",
  testPlanId: null,
  testSuiteIds: [],
  areaPath: null,
  iterationPath: null,
  workItemTypes: [],
  assignee: null,
};

const DATE_PRESET_OPTIONS = [
  { value: "7d", label: "Last 7 days" },
  { value: "14d", label: "Last 14 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "current_sprint", label: "Current sprint" },
  { value: "custom", label: "Custom range" },
];

export function DashboardFilters({
  value,
  effective,
  metadata,
  disabled,
  onChange,
}: {
  value: DashboardFilterState;
  effective?: DashboardFilters;
  metadata: DashboardFilterMetadata;
  disabled?: boolean;
  onChange: (value: DashboardFilterState) => void;
}) {
  const [moreFiltersOpen, setMoreFiltersOpen] = useState(false);
  const effectivePlanId = value.testPlanId ?? effective?.testPlanId ?? "";
  const effectiveTypes = value.workItemTypes.length ? value.workItemTypes : effective?.workItemTypes ?? [];
  const activeAdvanced = Boolean(value.areaPath || value.assignee || value.workItemTypes.length);

  function patch(next: Partial<DashboardFilterState>) {
    onChange({ ...value, ...next });
  }

  return (
    <section className="qa-card space-y-3 p-4">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5 xl:items-start">
        <div className="space-y-1.5">
          <Label className="text-sm font-semibold text-foreground">Date range</Label>
          <NativeSelect
            className="h-10"
            value={value.datePreset}
            onChange={(event) => patch({ datePreset: event.target.value as DashboardDatePreset })}
            disabled={disabled}
            aria-label="Dashboard date range"
          >
            {DATE_PRESET_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </NativeSelect>
        </div>

        <div className="space-y-1.5">
          <Label className="text-sm font-semibold text-foreground">Sprint</Label>
          <NativeSelect
            className="h-10"
            value={value.iterationPath ?? "__all__"}
            onChange={(event) => patch({ iterationPath: event.target.value === "__all__" ? null : event.target.value })}
            disabled={disabled}
            aria-label="Sprint"
          >
            <option value="__all__">All sprints</option>
            {metadata.iterations.map((iteration) => <option key={iteration.value} value={iteration.value}>{iteration.label}</option>)}
          </NativeSelect>
        </div>

        <div className="space-y-1.5">
          <Label className="text-sm font-semibold text-foreground">Test plan</Label>
          <SearchableCombobox
            value={effectivePlanId}
            options={metadata.testPlans}
            onValueChange={(testPlanId) => patch({ testPlanId, testSuiteIds: [] })}
            disabled={disabled || !metadata.testPlans.length}
            placeholder="No Test Plans available"
            searchPlaceholder="Search Test Plans"
            ariaLabel="Test Plan"
          />
        </div>

        <div className="space-y-1.5">
          <Label className="text-sm font-semibold text-foreground">Test suite</Label>
          <SearchableCombobox
            value={value.testSuiteIds[0] ?? ""}
            selectedLabel={value.testSuiteIds.length ? undefined : (effectivePlanId ? "All suites" : "Select a plan first")}
            options={[{ value: "__all__", label: "All suites" }, ...metadata.testSuites]}
            onValueChange={(testSuiteId) => patch({ testSuiteIds: testSuiteId === "__all__" ? [] : [testSuiteId] })}
            disabled={disabled || !effectivePlanId || !metadata.testSuites.length}
            placeholder={effectivePlanId ? "All suites" : "Select a plan first"}
            searchPlaceholder="Search Test Suites"
            ariaLabel="Test Suite"
          />
        </div>

        <Popover open={moreFiltersOpen} onOpenChange={setMoreFiltersOpen}>
          <PopoverTrigger asChild>
            <Button type="button" variant="outline" className="h-10 justify-start gap-2 px-3 md:mt-6" disabled={disabled}>
              <Filter className="size-4" />More filters{activeAdvanced ? " (active)" : ""}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-[min(720px,calc(100vw-2rem))] space-y-3 p-4">
            <div className="grid gap-3 md:grid-cols-2">
              <SearchableCombobox
                value={value.areaPath ?? ""}
                selectedLabel={value.areaPath ?? "All areas"}
                options={[{ value: "__all__", label: "All areas" }, ...metadata.areas]}
                onValueChange={(areaPath) => patch({ areaPath: areaPath === "__all__" ? null : areaPath })}
                disabled={disabled}
                placeholder="All areas"
                ariaLabel="Area Path"
              />
              <SearchableCombobox
                value={value.assignee ?? ""}
                selectedLabel={value.assignee ?? "All assignees"}
                options={[{ value: "__all__", label: "All assignees" }, ...metadata.assignees]}
                onValueChange={(assignee) => patch({ assignee: assignee === "__all__" ? null : assignee })}
                disabled={disabled}
                placeholder="All assignees"
                ariaLabel="Assignee"
              />
              <SearchableMultiSelect
                options={metadata.workItemTypes}
                value={effectiveTypes}
                onValueChange={(workItemTypes) => patch({ workItemTypes })}
                getOptionValue={(option) => option.value}
                getOptionLabel={(option) => option.label}
                disabled={disabled}
                placeholder="All requirement types"
                triggerClassName="h-10"
                ariaLabel="Requirement work item types"
              />
            </div>
            {activeAdvanced ? (
              <div className="flex justify-end">
                <Button type="button" size="sm" variant="ghost" onClick={() => patch({ areaPath: null, assignee: null, workItemTypes: [] })}>
                  <X className="size-4" />Clear advanced filters
                </Button>
              </div>
            ) : null}
          </PopoverContent>
        </Popover>
      </div>

      {value.datePreset === "custom" ? (
        <div className="grid gap-3 sm:grid-cols-2 sm:items-end">
          <div className="space-y-1.5">
            <Label htmlFor="dashboard-start-date">Start date</Label>
            <Input id="dashboard-start-date" type="date" value={value.from} max={value.to || undefined} onChange={(event) => patch({ from: event.target.value })} className="w-full sm:w-[180px]" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="dashboard-end-date">End date</Label>
            <Input id="dashboard-end-date" type="date" value={value.to} min={value.from || undefined} onChange={(event) => patch({ to: event.target.value })} className="w-full sm:w-[180px]" />
          </div>
        </div>
      ) : null}
    </section>
  );
}
