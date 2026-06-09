"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Edit3,
  FilterX,
  ListChecks,
  Save,
  Search,
  Trash2,
  X,
} from "lucide-react";

import { Callout } from "@/components/qa/callout";
import { ConfirmationDialog } from "@/components/qa/confirmation-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Metric,
  SectionCard,
  ToneBadge,
  formatEnumLabel,
  severityTone,
} from "@/components/workflow/test-intelligence-shared";
import type {
  RequirementFinding,
  RequirementSummary,
} from "@/components/workflow/test-intelligence-types";
import { requirementAnalysisChecklistOptions } from "@/modules/requirement-analysis/checklist-options";
import {
  requirementFindingSeverityValues,
  requirementIssueTypeValues,
  requirementRiskLevelValues,
} from "@/modules/requirement-analysis/finding-options";
import { cn } from "@/lib/utils";

const selectClass =
  "h-8 rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

export type RequirementFindingValidation = {
  valid: boolean;
  issues: string[];
};

export function validateRequirementFinding(finding: RequirementFinding): RequirementFindingValidation {
  const issues: string[] = [];
  if (!finding.title.trim()) issues.push("Add a title.");
  if (!finding.description.trim()) issues.push("Add a description.");
  if (!finding.suggestion.trim()) issues.push("Add a suggested resolution.");
  if (!finding.riskJustification.trim()) issues.push("Add a risk justification.");
  if (!requirementFindingSeverityValues.includes(finding.severity)) issues.push("Choose a valid severity.");
  if (!requirementIssueTypeValues.includes(finding.issueType)) issues.push("Choose a valid issue type.");
  if (!requirementRiskLevelValues.includes(finding.riskLevel)) issues.push("Choose a valid risk level.");
  return { valid: issues.length === 0, issues };
}

export function RequirementFindingsReview({
  findings,
  summary,
  selectedIds,
  onChange,
  onSelectedIdsChange,
  footer,
}: {
  findings: RequirementFinding[];
  summary: RequirementSummary;
  selectedIds: string[];
  onChange: (findings: RequirementFinding[]) => void;
  onSelectedIdsChange: (ids: string[]) => void;
  footer?: ReactNode;
}) {
  const [search, setSearch] = useState("");
  const [severityFilter, setSeverityFilter] = useState("all");
  const [issueTypeFilter, setIssueTypeFilter] = useState("all");
  const [riskFilter, setRiskFilter] = useState("all");
  const [selectedOnly, setSelectedOnly] = useState(false);
  const [editedOnly, setEditedOnly] = useState(false);
  const [editedIds, setEditedIds] = useState<string[]>([]);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const editedSet = useMemo(() => new Set(editedIds), [editedIds]);

  useEffect(() => {
    const findingIds = new Set(findings.map((finding) => finding.id));
    setEditedIds((current) => current.filter((id) => findingIds.has(id)));
  }, [findings]);

  const issueTypes = useMemo(
    () => [...new Set(findings.map((finding) => finding.issueType))].sort(),
    [findings],
  );
  const filteredFindings = useMemo(() => {
    const query = search.trim().toLowerCase();
    return findings.filter((finding) => {
      if (severityFilter !== "all" && finding.severity !== severityFilter) return false;
      if (issueTypeFilter !== "all" && finding.issueType !== issueTypeFilter) return false;
      if (riskFilter !== "all" && finding.riskLevel !== riskFilter) return false;
      if (selectedOnly && !selectedSet.has(finding.id)) return false;
      if (editedOnly && !editedSet.has(finding.id)) return false;
      if (!query) return true;
      return searchableFindingText(finding).includes(query);
    });
  }, [
    editedOnly,
    editedSet,
    findings,
    issueTypeFilter,
    riskFilter,
    search,
    selectedOnly,
    selectedSet,
    severityFilter,
  ]);

  const stats = useMemo(() => {
    const severityCounts = Object.fromEntries(
      requirementFindingSeverityValues.map((severity) => [
        severity,
        findings.filter((finding) => finding.severity === severity).length,
      ]),
    ) as Record<RequirementFinding["severity"], number>;
    const issueTypeCounts = findings.reduce<Record<string, number>>((counts, finding) => {
      counts[finding.issueType] = (counts[finding.issueType] ?? 0) + 1;
      return counts;
    }, {});
    return {
      invalid: findings.filter((finding) => !validateRequirementFinding(finding).valid).length,
      severityCounts,
      issueTypeCounts: Object.entries(issueTypeCounts).sort(([left], [right]) => left.localeCompare(right)),
    };
  }, [findings]);

  const visibleIds = filteredFindings.map((finding) => finding.id);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedSet.has(id));
  const someVisibleSelected = visibleIds.some((id) => selectedSet.has(id));
  const filtersActive =
    Boolean(search.trim()) ||
    severityFilter !== "all" ||
    issueTypeFilter !== "all" ||
    riskFilter !== "all" ||
    selectedOnly ||
    editedOnly;

  function updateFinding(next: RequirementFinding) {
    onChange(findings.map((finding) => (finding.id === next.id ? next : finding)));
    setEditedIds((current) => (current.includes(next.id) ? current : [...current, next.id]));
  }

  function deleteFinding(id: string) {
    onChange(findings.filter((finding) => finding.id !== id));
    onSelectedIdsChange(selectedIds.filter((selectedId) => selectedId !== id));
    setEditedIds((current) => current.filter((editedId) => editedId !== id));
  }

  function toggleVisibleSelection() {
    if (allVisibleSelected) {
      const visibleSet = new Set(visibleIds);
      onSelectedIdsChange(selectedIds.filter((id) => !visibleSet.has(id)));
      return;
    }
    onSelectedIdsChange([...new Set([...selectedIds, ...visibleIds])]);
  }

  function removeSelected() {
    const selected = new Set(selectedIds);
    onChange(findings.filter((finding) => !selected.has(finding.id)));
    onSelectedIdsChange([]);
    setEditedIds((current) => current.filter((id) => !selected.has(id)));
  }

  function clearFilters() {
    setSearch("");
    setSeverityFilter("all");
    setIssueTypeFilter("all");
    setRiskFilter("all");
    setSelectedOnly(false);
    setEditedOnly(false);
  }

  return (
    <SectionCard
      title="Requirements Analysis Findings"
      description="Review, refine, and select the findings that should be included in the Azure DevOps comment."
    >
      <FindingsSummary
        total={findings.length}
        selected={selectedIds.length}
        edited={editedIds.length}
        invalid={stats.invalid}
        severityCounts={stats.severityCounts}
        issueTypeCounts={stats.issueTypeCounts}
      />

      <div className="grid gap-3 border-b border-border p-4 md:grid-cols-4">
        <Metric label="Quality" value={summary.overallQuality} />
        <Metric label="Clarity" value={summary.clarityScore} />
        <Metric label="Completeness" value={summary.completenessScore} />
        <Metric label="Testability" value={summary.testabilityScore} />
      </div>

      <div className="space-y-3 border-b border-border p-4">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex min-w-0 flex-1 flex-col gap-2 md:flex-row md:flex-wrap md:items-center">
            <div className="relative min-w-0 flex-1 md:max-w-sm">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search ID, title, description, or resolution"
                aria-label="Search requirement findings"
                className="h-8 pl-8"
              />
            </div>
            <select
              className={selectClass}
              value={severityFilter}
              onChange={(event) => setSeverityFilter(event.target.value)}
              aria-label="Filter findings by severity"
            >
              <option value="all">All severities</option>
              {requirementFindingSeverityValues.map((severity) => (
                <option key={severity} value={severity}>{formatEnumLabel(severity)}</option>
              ))}
            </select>
            <select
              className={selectClass}
              value={issueTypeFilter}
              onChange={(event) => setIssueTypeFilter(event.target.value)}
              aria-label="Filter findings by issue type"
            >
              <option value="all">All issue types</option>
              {issueTypes.map((issueType) => (
                <option key={issueType} value={issueType}>{formatEnumLabel(issueType)}</option>
              ))}
            </select>
            <select
              className={selectClass}
              value={riskFilter}
              onChange={(event) => setRiskFilter(event.target.value)}
              aria-label="Filter findings by risk"
            >
              <option value="all">All risks</option>
              {requirementRiskLevelValues.map((risk) => (
                <option key={risk} value={risk}>{formatEnumLabel(risk)} risk</option>
              ))}
            </select>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ToolbarCheckbox label="Selected only" checked={selectedOnly} onChange={setSelectedOnly} />
            <ToolbarCheckbox label="Edited only" checked={editedOnly} onChange={setEditedOnly} />
            {filtersActive ? (
              <Button type="button" size="sm" variant="ghost" onClick={clearFilters}>
                <FilterX />
                Clear filters
              </Button>
            ) : null}
          </div>
        </div>

        <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/40 p-3 lg:flex-row lg:items-center lg:justify-between">
          <label className="flex cursor-pointer items-center gap-2 text-sm font-medium">
            <Checkbox
              checked={allVisibleSelected ? true : someVisibleSelected ? "indeterminate" : false}
              onCheckedChange={toggleVisibleSelection}
              aria-label="Select all visible findings"
            />
            Select all visible
            <span className="text-xs font-normal text-muted-foreground">({filteredFindings.length})</span>
          </label>
          <div className="flex flex-wrap gap-2">
            <ConfirmationDialog
              trigger={
                <Button type="button" size="sm" variant="destructive" disabled={!selectedIds.length}>
                  <Trash2 />
                  Remove selected
                </Button>
              }
              title="Remove selected findings?"
              description={`${selectedIds.length} selected finding${selectedIds.length === 1 ? "" : "s"} will be removed from this analysis draft.`}
              confirmLabel="Remove findings"
              onConfirm={removeSelected}
            />
          </div>
        </div>
      </div>

      <div className="space-y-3 bg-muted/20 p-4">
        {filteredFindings.length ? filteredFindings.map((finding) => (
          <RequirementFindingReviewCard
            key={finding.id}
            finding={finding}
            selected={selectedSet.has(finding.id)}
            onSelectedChange={(selected) => {
              onSelectedIdsChange(
                selected
                  ? [...new Set([...selectedIds, finding.id])]
                  : selectedIds.filter((id) => id !== finding.id),
              );
            }}
            edited={editedSet.has(finding.id)}
            onChange={updateFinding}
            onDelete={() => deleteFinding(finding.id)}
          />
        )) : (
          <div className="rounded-xl border border-dashed border-border bg-card p-8 text-center">
            <ListChecks className="mx-auto size-8 text-muted-foreground" />
            <div className="mt-3 font-medium text-foreground">
              {findings.length ? "No findings match the current filters." : "No requirement findings remain."}
            </div>
            {filtersActive ? (
              <Button type="button" variant="link" onClick={clearFilters} className="mt-1">
                Clear filters
              </Button>
            ) : null}
          </div>
        )}
      </div>

      {footer ? <div className="border-t border-border bg-card p-4">{footer}</div> : null}
    </SectionCard>
  );
}

function RequirementFindingReviewCard({
  finding,
  selected,
  onSelectedChange,
  edited,
  onChange,
  onDelete,
}: {
  finding: RequirementFinding;
  selected: boolean;
  onSelectedChange: (selected: boolean) => void;
  edited: boolean;
  onChange: (finding: RequirementFinding) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(finding);
  const validation = validateRequirementFinding(finding);

  useEffect(() => {
    if (!editing) setDraft(finding);
  }, [editing, finding]);

  function beginEditing() {
    setDraft(finding);
    setEditing(true);
  }

  function saveEditing() {
    onChange({
      ...draft,
      title: draft.title.trim(),
      description: draft.description.trim(),
      suggestion: draft.suggestion.trim(),
      riskJustification: draft.riskJustification.trim(),
    });
    setEditing(false);
  }

  function cancelEditing() {
    setDraft(finding);
    setEditing(false);
  }

  return (
    <Card
      className={cn(
        "gap-0 overflow-hidden py-0 shadow-sm transition",
        selected && "ring-2 ring-primary/35",
        !validation.valid && "ring-destructive/30",
      )}
    >
      <div className="p-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <Checkbox
              checked={selected}
              onCheckedChange={(checked) => onSelectedChange(checked === true)}
              aria-label={`Select ${finding.id}`}
              className="mt-1"
            />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs font-semibold text-primary">{finding.id}</span>
                {edited ? <ToneBadge tone="draft">Edited</ToneBadge> : null}
                {!validation.valid ? (
                  <ToneBadge tone="error">
                    {validation.issues.length} issue{validation.issues.length === 1 ? "" : "s"}
                  </ToneBadge>
                ) : null}
              </div>
              <h3 className="mt-1 text-base font-semibold leading-6 text-foreground">
                {finding.title || "Untitled finding"}
              </h3>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <ToneBadge tone={severityTone(finding.severity)}>{formatEnumLabel(finding.severity)}</ToneBadge>
                <Badge variant="outline">{formatEnumLabel(finding.issueType)}</Badge>
                <Badge variant="secondary">{formatEnumLabel(finding.riskLevel)} risk</Badge>
                <Badge variant="outline">{checklistTitle(finding)}</Badge>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="secondary" onClick={beginEditing} disabled={editing}>
              <Edit3 />
              Edit
            </Button>
            <ConfirmationDialog
              trigger={
                <Button type="button" size="sm" variant="ghost" aria-label={`Delete ${finding.id}`}>
                  <Trash2 className="text-destructive" />
                  Delete
                </Button>
              }
              title={`Delete ${finding.id}?`}
              description="This finding will be removed from the analysis draft and excluded from the Azure DevOps comment."
              confirmLabel="Delete finding"
              onConfirm={onDelete}
            />
          </div>
        </div>

        {!editing ? (
          <div className="mt-4 grid gap-3 lg:grid-cols-2">
            <PreviewSection label="Finding" value={finding.description || "No description supplied."} />
            <PreviewSection label="Suggested resolution" value={finding.suggestion || "No resolution supplied."} />
            <PreviewSection
              label="Risk justification"
              value={finding.riskJustification || "No risk justification supplied."}
              className="lg:col-span-2"
            />
          </div>
        ) : null}
      </div>

      {!validation.valid && !editing ? (
        <div className="border-t border-destructive/20 bg-destructive/5 px-4 py-3">
          <div className="text-xs font-semibold text-destructive">Resolve before pushing this finding</div>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-destructive">
            {validation.issues.map((issue) => <li key={issue}>{issue}</li>)}
          </ul>
        </div>
      ) : null}

      {editing ? (
        <div className="border-t border-border">
          <FindingEditForm draft={draft} onChange={setDraft} onSave={saveEditing} onCancel={cancelEditing} />
        </div>
      ) : null}
    </Card>
  );
}

function FindingsSummary({
  total,
  selected,
  edited,
  invalid,
  severityCounts,
  issueTypeCounts,
}: {
  total: number;
  selected: number;
  edited: number;
  invalid: number;
  severityCounts: Record<RequirementFinding["severity"], number>;
  issueTypeCounts: Array<[string, number]>;
}) {
  return (
    <div className="grid gap-3 border-b border-border bg-muted/30 p-4 sm:grid-cols-2 xl:grid-cols-4">
      <SummaryMetric label="Findings" value={total} />
      <SummaryMetric label="Selected" value={selected} tone="primary" />
      <SummaryMetric label="Edited" value={edited} tone={edited ? "warning" : "neutral"} />
      <SummaryMetric label="Validation issues" value={invalid} tone={invalid ? "error" : "success"} />
      <div className="rounded-xl border border-border bg-card p-3 xl:col-span-2">
        <div className="text-xs font-medium text-muted-foreground">Severity</div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {requirementFindingSeverityValues.map((severity) => (
            <Badge key={severity} variant="secondary">
              {formatEnumLabel(severity)} {severityCounts[severity]}
            </Badge>
          ))}
        </div>
      </div>
      <div className="rounded-xl border border-border bg-card p-3 xl:col-span-2">
        <div className="text-xs font-medium text-muted-foreground">Issue Type</div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {issueTypeCounts.map(([issueType, count]) => (
            <Badge key={issueType} variant="outline">{formatEnumLabel(issueType)} {count}</Badge>
          ))}
        </div>
      </div>
    </div>
  );
}

function SummaryMetric({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: number;
  tone?: "neutral" | "primary" | "warning" | "error" | "success";
}) {
  const toneClass = {
    neutral: "text-foreground",
    primary: "text-primary",
    warning: "text-warning-foreground dark:text-warning",
    error: "text-destructive",
    success: "text-success",
  }[tone];
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className={cn("mt-1 text-2xl font-bold", toneClass)}>{value}</div>
    </div>
  );
}

function ToolbarCheckbox({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs font-medium">
      <Checkbox checked={checked} onCheckedChange={(value) => onChange(value === true)} />
      {label}
    </label>
  );
}

function PreviewSection({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className={cn("rounded-lg border border-border bg-muted/30 p-3", className)}>
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      <p className="mt-1 whitespace-pre-line text-sm leading-6 text-foreground">{value}</p>
    </div>
  );
}

function FindingEditForm({
  draft,
  onChange,
  onSave,
  onCancel,
}: {
  draft: RequirementFinding;
  onChange: (finding: RequirementFinding) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const validation = validateRequirementFinding(draft);

  function patch(patchValue: Partial<RequirementFinding>) {
    onChange({ ...draft, ...patchValue });
  }

  return (
    <div className="space-y-5 bg-muted/15 p-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <EditorField label="Title" className="lg:col-span-2">
          <Input
            value={draft.title}
            onChange={(event) => patch({ title: event.target.value })}
            aria-invalid={!draft.title.trim()}
          />
        </EditorField>
        <EditorField label="Severity">
          <select
            className={cn(selectClass, "h-9 w-full")}
            value={draft.severity}
            onChange={(event) => patch({ severity: event.target.value as RequirementFinding["severity"] })}
          >
            {requirementFindingSeverityValues.map((severity) => (
              <option key={severity} value={severity}>{formatEnumLabel(severity)}</option>
            ))}
          </select>
        </EditorField>
        <EditorField label="Issue type">
          <select
            className={cn(selectClass, "h-9 w-full")}
            value={draft.issueType}
            onChange={(event) => patch({ issueType: event.target.value as RequirementFinding["issueType"] })}
          >
            {requirementIssueTypeValues.map((issueType) => (
              <option key={issueType} value={issueType}>{formatEnumLabel(issueType)}</option>
            ))}
          </select>
        </EditorField>
        <EditorField label="Risk level" className="lg:col-span-2">
          <select
            className={cn(selectClass, "h-9 w-full")}
            value={draft.riskLevel}
            onChange={(event) => patch({ riskLevel: event.target.value as RequirementFinding["riskLevel"] })}
          >
            {requirementRiskLevelValues.map((risk) => (
              <option key={risk} value={risk}>{formatEnumLabel(risk)}</option>
            ))}
          </select>
        </EditorField>
        <EditorField label="Description" className="lg:col-span-2">
          <Textarea
            value={draft.description}
            onChange={(event) => patch({ description: event.target.value })}
            className="min-h-28"
            aria-invalid={!draft.description.trim()}
          />
        </EditorField>
        <EditorField label="Risk justification" className="lg:col-span-2">
          <Textarea
            value={draft.riskJustification}
            onChange={(event) => patch({ riskJustification: event.target.value })}
            className="min-h-24"
            aria-invalid={!draft.riskJustification.trim()}
          />
        </EditorField>
        <EditorField label="Suggested resolution" className="lg:col-span-2">
          <Textarea
            value={draft.suggestion}
            onChange={(event) => patch({ suggestion: event.target.value })}
            className="min-h-28"
            aria-invalid={!draft.suggestion.trim()}
          />
        </EditorField>
      </div>

      {!validation.valid ? (
        <Callout tone="warning" title="This finding is not ready to push">
          <ul className="list-disc space-y-1 pl-4">
            {validation.issues.map((issue) => <li key={issue}>{issue}</li>)}
          </ul>
        </Callout>
      ) : null}

      <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
        <Button type="button" variant="outline" onClick={onCancel}>
          <X />
          Cancel
        </Button>
        <Button type="button" onClick={onSave}>
          <Save />
          Save changes
        </Button>
      </div>
    </div>
  );
}

function EditorField({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("grid content-start gap-1.5", className)}>
      <Label className="text-xs font-semibold">{label}</Label>
      {children}
    </div>
  );
}

function checklistTitle(finding: RequirementFinding) {
  return requirementAnalysisChecklistOptions.find((item) => item.id === finding.checklistItemId)?.title
    ?? formatEnumLabel(finding.checklistItemId);
}

function searchableFindingText(finding: RequirementFinding) {
  return [
    finding.id,
    finding.title,
    finding.description,
    finding.suggestion,
    finding.riskJustification,
    finding.severity,
    finding.issueType,
    finding.riskLevel,
    checklistTitle(finding),
  ].join(" ").toLowerCase();
}
