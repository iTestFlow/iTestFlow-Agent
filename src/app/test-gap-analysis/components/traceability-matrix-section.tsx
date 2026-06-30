"use client";

import { useEffect, useMemo, useState } from "react";
import { Search, X } from "lucide-react";

import { Accordion } from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyBlock, SectionCard } from "@/components/workflow/test-intelligence-shared";
import type { ExistingTraceabilityRow } from "@/components/workflow/test-intelligence-types";

import {
  EMPTY_MATRIX_FILTER,
  coverageFilterOptions,
  formatCoverageFilterLabel,
  formatSourceFilterLabel,
  linkStateFilterOptions,
  matchesMatrixFilter,
  matrixActiveCount,
  severityFilterOptions,
  sourceFilterOptions,
  type CoverageFilter,
  type LinkStateFilter,
  type MatrixFilterState,
  type SeverityFilter,
  type SourceFilter,
} from "../lib/matrix-filters";
import { ActiveFilterSummary, FilterChip, filterSelectClass } from "./filter-controls";
import { RelatedIdChips } from "./shared-chips";
import { TraceabilityMatrixColumnHeader, TraceabilityRowPanel } from "./traceability-row-panel";

export function TraceabilityMatrixSection({
  rows,
  affectedRowIds,
  onClearAffectedRows,
}: {
  rows: ExistingTraceabilityRow[];
  affectedRowIds: string[];
  onClearAffectedRows: () => void;
}) {
  const [filter, setFilter] = useState<MatrixFilterState>(EMPTY_MATRIX_FILTER);
  const [openRowIds, setOpenRowIds] = useState<string[]>([]);
  const affectedRowKey = affectedRowIds.join("|");
  const affectedRowSet = useMemo(() => new Set(affectedRowIds), [affectedRowIds]);
  const affectedMode = affectedRowIds.length > 0;

  // Entering "affected mode" (from a finding's "View affected rows") clears the
  // normal filters and opens exactly the affected rows.
  useEffect(() => {
    if (!affectedRowIds.length) return;
    setFilter(EMPTY_MATRIX_FILTER);
    setOpenRowIds(affectedRowIds);
  }, [affectedRowKey, affectedRowIds]);

  const filteredRows = useMemo(() => {
    if (affectedMode) {
      return rows.filter((row) => affectedRowSet.has(row.id));
    }
    return rows.filter((row) => matchesMatrixFilter(row, filter));
  }, [affectedMode, affectedRowSet, rows, filter]);

  const activeCount = matrixActiveCount(filter);

  function leaveAffectedMode() {
    if (affectedMode) onClearAffectedRows();
  }

  function clearFilters() {
    setFilter(EMPTY_MATRIX_FILTER);
    if (affectedMode) onClearAffectedRows();
  }

  function update(patch: Partial<MatrixFilterState>) {
    leaveAffectedMode();
    setFilter((current) => ({ ...current, ...patch }));
  }

  function toggleGapsOnly() {
    leaveAffectedMode();
    setFilter((current) => ({ ...current, gapsOnly: !current.gapsOnly }));
  }

  function toggleLinkState(value: LinkStateFilter) {
    update({ linkState: filter.linkState === value ? "All" : value });
  }

  function toggleSeverity(value: SeverityFilter) {
    update({ severity: filter.severity === value ? "All" : value });
  }

  return (
    <SectionCard
      title="Traceability Matrix"
      description="Evidence and audit trail — expand any row to inspect coverage evidence and recommended action."
      action={<span className="text-xs text-muted-foreground">{filteredRows.length} of {rows.length} rows</span>}
    >
      {rows.length ? (
        <>
          <div className="space-y-3 border-b border-border p-4">
            <div className="flex flex-wrap items-center gap-2">
              <FilterChip active={filter.gapsOnly} onClick={toggleGapsOnly}>
                Gaps only
              </FilterChip>
              <FilterChip active={filter.linkState === "No linked test cases"} onClick={() => toggleLinkState("No linked test cases")}>
                No linked test cases
              </FilterChip>
              <FilterChip active={filter.linkState === "Has linked test cases"} onClick={() => toggleLinkState("Has linked test cases")}>
                Has linked test cases
              </FilterChip>
              <FilterChip active={filter.severity === "High"} onClick={() => toggleSeverity("High")}>
                High severity
              </FilterChip>
            </div>
            <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
              <div className="flex min-w-0 flex-1 flex-col gap-2 md:flex-row md:flex-wrap md:items-center">
                <div className="relative min-w-0 flex-1 md:max-w-sm">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={filter.search}
                    onChange={(event) => update({ search: event.target.value })}
                    placeholder="Search matrix rows"
                    aria-label="Search traceability matrix rows"
                    className="h-8 pl-8"
                  />
                </div>
                <select
                  className={filterSelectClass}
                  value={filter.coverage}
                  onChange={(event) => update({ coverage: event.target.value as CoverageFilter })}
                  aria-label="Filter by coverage status"
                >
                  {coverageFilterOptions.map((option) => (
                    <option key={option} value={option}>{formatCoverageFilterLabel(option)}</option>
                  ))}
                </select>
                <select
                  className={filterSelectClass}
                  value={filter.severity}
                  onChange={(event) => update({ severity: event.target.value as SeverityFilter })}
                  aria-label="Filter by severity"
                >
                  {severityFilterOptions.map((option) => (
                    <option key={option} value={option}>{option === "All" ? "All severity" : option}</option>
                  ))}
                </select>
                <select
                  className={filterSelectClass}
                  value={filter.source}
                  onChange={(event) => update({ source: event.target.value as SourceFilter })}
                  aria-label="Filter by source"
                >
                  {sourceFilterOptions.map((option) => (
                    <option key={option} value={option}>{formatSourceFilterLabel(option)}</option>
                  ))}
                </select>
                <select
                  className={filterSelectClass}
                  value={filter.linkState}
                  onChange={(event) => update({ linkState: event.target.value as LinkStateFilter })}
                  aria-label="Filter by linked test-case state"
                >
                  {linkStateFilterOptions.map((option) => (
                    <option key={option} value={option}>{option === "All" ? "All linked test cases" : option}</option>
                  ))}
                </select>
              </div>
              <ActiveFilterSummary count={activeCount} onClear={clearFilters} />
            </div>
            {affectedMode ? (
              <div className="flex flex-col gap-2 rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span>Showing affected rows</span>
                  <RelatedIdChips ids={affectedRowIds} tone="primary" />
                </div>
                <Button type="button" variant="ghost" size="sm" onClick={onClearAffectedRows}>
                  <X className="size-3.5" />
                  Clear affected rows
                </Button>
              </div>
            ) : null}
          </div>
          {filteredRows.length ? (
            <div className="p-4">
              <TraceabilityMatrixColumnHeader />
              <Accordion type="multiple" value={openRowIds} onValueChange={setOpenRowIds} className="mt-2 space-y-2">
                {filteredRows.map((row) => (
                  <TraceabilityRowPanel
                    key={row.id}
                    row={row}
                    highlighted={affectedRowSet.has(row.id)}
                  />
                ))}
              </Accordion>
            </div>
          ) : (
            <EmptyBlock message="No traceability rows match the current filters." />
          )}
        </>
      ) : (
        <EmptyBlock message="No traceability rows were returned by the LLM." />
      )}
    </SectionCard>
  );
}
