"use client";

import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Callout } from "@/components/qa/callout";
import { EmptyBlock, SectionCard } from "@/components/workflow/test-intelligence-shared";
import { cn } from "@/lib/utils";
import type { ExistingReviewFinding, ExistingReviewInsight } from "@/components/workflow/test-intelligence-types";

import {
  EMPTY_FINDINGS_FILTER,
  buildReviewItems,
  coverageItemKindFilterOptions,
  coverageItemRelatedFilterOptions,
  deriveCategoryOptions,
  findingsActiveCount,
  formatCoverageItemKindFilterLabel,
  formatCoverageItemRelatedFilterLabel,
  matchesFindingsFilter,
  type CoverageItemKindFilter,
  type CoverageItemRelatedFilter,
  type CoverageReviewItem,
  type FindingsFilterState,
} from "../lib/findings-filters";
import { severityFilterOptions, type SeverityFilter } from "../lib/matrix-filters";
import { ActiveFilterSummary, FilterChip, filterSelectClass } from "./filter-controls";
import { FindingReviewCard } from "./finding-review-card";

/* The primary review section: actionable gaps, weak coverage, and recommended
 * improvements. Items are grouped by priority and rendered as compact,
 * expandable cards on top of the existing client-side filters and search. */

type FindingGroup = {
  key: string;
  label: string;
  dotClass: string;
  items: CoverageReviewItem[];
};

export function FindingsReviewQueue({
  findings,
  insights,
  onViewAffectedRows,
}: {
  findings: ExistingReviewFinding[];
  insights: ExistingReviewInsight[];
  onViewAffectedRows: (rowIds: string[]) => void;
}) {
  const [filter, setFilter] = useState<FindingsFilterState>(EMPTY_FINDINGS_FILTER);

  const reviewItems = useMemo(() => buildReviewItems(findings, insights), [findings, insights]);
  const categoryOptions = useMemo(() => deriveCategoryOptions(findings), [findings]);
  const filteredReviewItems = useMemo(
    () => reviewItems.filter((item) => matchesFindingsFilter(item, filter)),
    [reviewItems, filter],
  );

  const groups = useMemo<FindingGroup[]>(() => {
    const isFindingWith = (severity: ExistingReviewFinding["severity"]) => (item: CoverageReviewItem) =>
      item.kind === "finding" && item.severity === severity;
    return [
      { key: "high", label: "High priority", dotClass: "bg-destructive", items: filteredReviewItems.filter(isFindingWith("High")) },
      { key: "medium", label: "Medium priority", dotClass: "bg-warning", items: filteredReviewItems.filter(isFindingWith("Medium")) },
      { key: "low", label: "Low priority", dotClass: "bg-success", items: filteredReviewItems.filter(isFindingWith("Low")) },
      { key: "notes", label: "Notes & informational", dotClass: "bg-muted-foreground/50", items: filteredReviewItems.filter((item) => item.kind === "note") },
    ];
  }, [filteredReviewItems]);

  // Reset filters whenever a new analysis result arrives.
  useEffect(() => {
    setFilter(EMPTY_FINDINGS_FILTER);
  }, [findings, insights]);

  const activeCount = findingsActiveCount(filter);

  function clearFilters() {
    setFilter(EMPTY_FINDINGS_FILTER);
  }

  function toggleSeverity(value: SeverityFilter) {
    setFilter((current) => ({ ...current, severity: current.severity === value ? "All" : value }));
  }

  function toggleItemKind(value: CoverageItemKindFilter) {
    setFilter((current) => ({ ...current, itemKind: current.itemKind === value ? "All" : value }));
  }

  function toggleRelated(value: CoverageItemRelatedFilter) {
    setFilter((current) => ({ ...current, related: current.related === value ? "All" : value }));
  }

  function toggleCategory(value: string) {
    setFilter((current) => ({ ...current, category: current.category === value ? "All" : value }));
  }

  // Category chips only render when the generated findings actually contain a
  // matching category, and they drive the existing category filter.
  const missingCoverageCategory = categoryOptions.find((option) => option.toLowerCase() === "missing coverage");
  const weakExpectedCategory = categoryOptions.find((option) => option.toLowerCase().includes("weak expected"));

  return (
    <SectionCard
      description="Review actionable gaps, weak coverage, and recommended test improvements."
      action={<span className="text-xs text-muted-foreground">{filteredReviewItems.length} of {reviewItems.length} items</span>}
    >
      {reviewItems.length ? (
        <>
          <div className="space-y-3 border-b border-border p-4">
            <div className="flex flex-wrap items-center gap-2">
              <FilterChip active={filter.severity === "High"} onClick={() => toggleSeverity("High")}>
                High severity
              </FilterChip>
              <FilterChip active={filter.itemKind === "finding"} onClick={() => toggleItemKind("finding")}>
                Findings only
              </FilterChip>
              <FilterChip active={filter.related === "No test cases"} onClick={() => toggleRelated("No test cases")}>
                No linked test cases
              </FilterChip>
              {missingCoverageCategory ? (
                <FilterChip
                  active={filter.category === missingCoverageCategory}
                  onClick={() => toggleCategory(missingCoverageCategory)}
                >
                  Missing coverage
                </FilterChip>
              ) : null}
              {weakExpectedCategory ? (
                <FilterChip
                  active={filter.category === weakExpectedCategory}
                  onClick={() => toggleCategory(weakExpectedCategory)}
                >
                  Weak expected result
                </FilterChip>
              ) : null}
            </div>
            <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
              <div className="flex min-w-0 flex-1 flex-col gap-2 md:flex-row md:flex-wrap md:items-center">
                <div className="relative min-w-0 flex-1 md:max-w-sm">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={filter.search}
                    onChange={(event) => setFilter((current) => ({ ...current, search: event.target.value }))}
                    placeholder="Search findings, notes, or test cases"
                    aria-label="Search coverage findings and notes"
                    className="h-8 pl-8"
                  />
                </div>
                <select
                  className={filterSelectClass}
                  value={filter.itemKind}
                  onChange={(event) => setFilter((current) => ({ ...current, itemKind: event.target.value as CoverageItemKindFilter }))}
                  aria-label="Filter by item type"
                >
                  {coverageItemKindFilterOptions.map((option) => (
                    <option key={option} value={option}>{formatCoverageItemKindFilterLabel(option)}</option>
                  ))}
                </select>
                <select
                  className={filterSelectClass}
                  value={filter.severity}
                  onChange={(event) => setFilter((current) => ({ ...current, severity: event.target.value as SeverityFilter }))}
                  aria-label="Filter coverage items by severity"
                >
                  {severityFilterOptions.map((option) => (
                    <option key={option} value={option}>{option === "All" ? "All severity" : option}</option>
                  ))}
                </select>
                <select
                  className={filterSelectClass}
                  value={filter.category}
                  onChange={(event) => setFilter((current) => ({ ...current, category: event.target.value }))}
                  aria-label="Filter findings by category"
                >
                  {categoryOptions.map((option) => (
                    <option key={option} value={option}>{option === "All" ? "All categories" : option}</option>
                  ))}
                </select>
                <select
                  className={filterSelectClass}
                  value={filter.related}
                  onChange={(event) => setFilter((current) => ({ ...current, related: event.target.value as CoverageItemRelatedFilter }))}
                  aria-label="Filter by related data"
                >
                  {coverageItemRelatedFilterOptions.map((option) => (
                    <option key={option} value={option}>{formatCoverageItemRelatedFilterLabel(option)}</option>
                  ))}
                </select>
              </div>
              <ActiveFilterSummary count={activeCount} onClear={clearFilters} />
            </div>
          </div>
          {filteredReviewItems.length ? (
            <div className="space-y-5 p-4">
              {groups.map((group) =>
                group.items.length ? (
                  <section key={group.key} className="space-y-2" aria-label={`${group.label} (${group.items.length})`}>
                    <div className="flex items-center gap-2">
                      <span className={cn("size-2 rounded-full", group.dotClass)} aria-hidden="true" />
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground">{group.label}</h3>
                      <span className="text-xs text-muted-foreground">({group.items.length})</span>
                    </div>
                    <div className="grid items-start gap-2 md:grid-cols-2">
                      {group.items.map((item) => (
                        <FindingReviewCard
                          key={`${item.kind}-${item.id}`}
                          item={item}
                          onViewAffectedRows={onViewAffectedRows}
                        />
                      ))}
                    </div>
                  </section>
                ) : null,
              )}
            </div>
          ) : (
            <div className="space-y-3 p-4">
              <EmptyBlock message="No coverage items match the current filters." />
              <Button type="button" variant="link" onClick={clearFilters} className="px-0">
                Clear filters
              </Button>
            </div>
          )}
        </>
      ) : (
        <div className="p-4">
          <Callout tone="success">No coverage gaps or findings — the linked tests cover the reviewed points.</Callout>
        </div>
      )}
    </SectionCard>
  );
}
