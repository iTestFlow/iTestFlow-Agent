"use client";

import { Filter, X } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SearchableCombobox } from "@/components/ui/searchable-combobox";
import { SearchableMultiSelect } from "@/components/ui/searchable-multi-select";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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
  datePreset: "30d",
  from: "",
  to: "",
  testPlanId: null,
  testSuiteIds: [],
  areaPath: null,
  iterationPath: null,
  workItemTypes: [],
  assignee: null,
};

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
  const activeAdvanced = Boolean(value.areaPath || value.iterationPath || value.assignee || value.workItemTypes.length);

  function patch(next: Partial<DashboardFilterState>) {
    onChange({ ...value, ...next });
  }

  return (
    <section className="qa-card space-y-3 p-4">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Select value={value.datePreset} onValueChange={(datePreset) => patch({ datePreset: datePreset as DashboardDatePreset })} disabled={disabled}>
          <SelectTrigger aria-label="Dashboard date range"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="7d">Last 7 days</SelectItem>
            <SelectItem value="14d">Last 14 days</SelectItem>
            <SelectItem value="30d">Last 30 days</SelectItem>
            <SelectItem value="current_sprint">Current sprint</SelectItem>
            <SelectItem value="custom">Custom range</SelectItem>
          </SelectContent>
        </Select>

        <SearchableCombobox
          value={effectivePlanId}
          options={metadata.testPlans}
          onValueChange={(testPlanId) => patch({ testPlanId, testSuiteIds: [] })}
          disabled={disabled || !metadata.testPlans.length}
          placeholder="No Test Plans available"
          searchPlaceholder="Search Test Plans"
          ariaLabel="Test Plan"
        />

        <SearchableCombobox
          value={value.testSuiteIds[0] ?? ""}
          selectedLabel={value.testSuiteIds.length ? undefined : "All suites"}
          options={[{ value: "__all__", label: "All suites" }, ...metadata.testSuites]}
          onValueChange={(testSuiteId) => patch({ testSuiteIds: testSuiteId === "__all__" ? [] : [testSuiteId] })}
          disabled={disabled || !effectivePlanId || !metadata.testSuites.length}
          placeholder="All suites"
          searchPlaceholder="Search Test Suites"
          ariaLabel="Test Suite"
        />

        <Popover open={moreFiltersOpen} onOpenChange={setMoreFiltersOpen}>
          <PopoverTrigger asChild>
            <Button type="button" variant="outline" className="h-10 justify-start gap-2 px-3" disabled={disabled}>
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
                value={value.iterationPath ?? ""}
                selectedLabel={value.iterationPath ?? "All iterations"}
                options={[{ value: "__all__", label: "All iterations" }, ...metadata.iterations]}
                onValueChange={(iterationPath) => patch({ iterationPath: iterationPath === "__all__" ? null : iterationPath })}
                disabled={disabled}
                placeholder="All iterations"
                ariaLabel="Iteration"
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
                <Button type="button" size="sm" variant="ghost" onClick={() => patch({ areaPath: null, iterationPath: null, assignee: null, workItemTypes: [] })}>
                  <X className="size-4" />Clear advanced filters
                </Button>
              </div>
            ) : null}
          </PopoverContent>
        </Popover>
      </div>

      {value.datePreset === "custom" ? (
        <div className="flex flex-wrap items-center gap-2">
          <Input type="date" aria-label="Dashboard start date" value={value.from} max={value.to || undefined} onChange={(event) => patch({ from: event.target.value })} className="w-[170px]" />
          <span className="text-xs text-muted-foreground">to</span>
          <Input type="date" aria-label="Dashboard end date" value={value.to} min={value.from || undefined} onChange={(event) => patch({ to: event.target.value })} className="w-[170px]" />
        </div>
      ) : null}
    </section>
  );
}
