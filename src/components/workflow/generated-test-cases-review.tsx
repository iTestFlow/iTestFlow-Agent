"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  Copy,
  Edit3,
  FilterX,
  ListChecks,
  Plus,
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
import { cn } from "@/lib/utils";
import type { GeneratedTestCase } from "@/components/workflow/test-intelligence-types";
import { SectionCard, ToneBadge, formatEnumLabel } from "@/components/workflow/test-intelligence-shared";

const PRECONDITIONS_EXPECTED_RESULT = "Preconditions are met";
const TEST_CASE_TYPES = [
  "functional",
  "smoke",
  "sanity",
  "regression",
  "e2e",
  "integration",
  "unit",
  "api",
  "ui",
  "security",
  "performance",
  "accessibility",
];
const selectClass =
  "h-8 rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

export type GeneratedTestCaseValidation = {
  valid: boolean;
  issues: string[];
};

export function validateGeneratedTestCase(testCase: GeneratedTestCase): GeneratedTestCaseValidation {
  const issues: string[] = [];
  const executionSteps = getExecutionSteps(testCase);

  if (!testCase.title.trim()) issues.push("Add a title.");
  if (!testCase.type.trim()) issues.push("Choose a test type.");
  if (!testCase.category.trim()) issues.push("Add a category.");
  if (!testCase.preconditions.trim()) issues.push("Add preconditions.");
  if (!executionSteps.length) issues.push("Add at least one executable step.");
  if (executionSteps.some((step) => !step.action.trim())) issues.push("Every executable step needs an action.");
  if (executionSteps.some((step) => !step.expectedResult.trim())) issues.push("Every executable step needs an expected result.");

  return { valid: issues.length === 0, issues };
}

export function GeneratedTestCasesReview({
  testCases,
  onChange,
  selectedIds,
  onSelectedIdsChange,
  title = "Generated Test Cases Review",
  description = "Review generated test cases, expand details, and edit only the cases that need refinement.",
  allowAdd = true,
  allowDelete = true,
}: {
  testCases: GeneratedTestCase[];
  onChange: (testCases: GeneratedTestCase[]) => void;
  selectedIds: string[];
  onSelectedIdsChange: (ids: string[]) => void;
  title?: string;
  description?: string;
  allowAdd?: boolean;
  allowDelete?: boolean;
}) {
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [priorityFilter, setPriorityFilter] = useState("all");
  const [tagFilter, setTagFilter] = useState("all");
  const [selectedOnly, setSelectedOnly] = useState(false);
  const [editedOnly, setEditedOnly] = useState(false);
  const [expandedIds, setExpandedIds] = useState<string[]>([]);
  const [editedIds, setEditedIds] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const editedSet = useMemo(() => new Set(editedIds), [editedIds]);

  const types = useMemo(
    () => [...new Set(testCases.map((testCase) => testCase.type).filter(Boolean))].sort(),
    [testCases],
  );
  const tags = useMemo(
    () => [...new Set(testCases.flatMap((testCase) => testCase.tags ?? []).filter(Boolean))].sort(),
    [testCases],
  );
  const filteredCases = useMemo(() => {
    const query = search.trim().toLowerCase();
    return testCases.filter((testCase) => {
      if (typeFilter !== "all" && testCase.type !== typeFilter) return false;
      if (priorityFilter !== "all" && String(testCase.priority) !== priorityFilter) return false;
      if (tagFilter !== "all" && !(testCase.tags ?? []).includes(tagFilter)) return false;
      if (selectedOnly && !selectedSet.has(testCase.id)) return false;
      if (editedOnly && !editedSet.has(testCase.id)) return false;
      if (!query) return true;
      return searchableTestCaseText(testCase).includes(query);
    });
  }, [editedOnly, editedSet, priorityFilter, search, selectedOnly, selectedSet, tagFilter, testCases, typeFilter]);

  const stats = useMemo(() => {
    const invalid = testCases.filter((testCase) => !validateGeneratedTestCase(testCase).valid).length;
    const byType = testCases.reduce<Record<string, number>>((counts, testCase) => {
      counts[testCase.type] = (counts[testCase.type] ?? 0) + 1;
      return counts;
    }, {});
    return {
      invalid,
      priorityOne: testCases.filter((testCase) => testCase.priority === 1).length,
      byType: Object.entries(byType).sort(([first], [second]) => first.localeCompare(second)),
    };
  }, [testCases]);

  const visibleIds = filteredCases.map((testCase) => testCase.id);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedSet.has(id));
  const someVisibleSelected = visibleIds.some((id) => selectedSet.has(id));
  const filtersActive =
    Boolean(search.trim()) ||
    typeFilter !== "all" ||
    priorityFilter !== "all" ||
    tagFilter !== "all" ||
    selectedOnly ||
    editedOnly;

  function updateCase(next: GeneratedTestCase) {
    onChange(testCases.map((testCase) => (testCase.id === next.id ? next : testCase)));
    setEditedIds((current) => (current.includes(next.id) ? current : [...current, next.id]));
  }

  function deleteCase(id: string) {
    onChange(testCases.filter((testCase) => testCase.id !== id));
    onSelectedIdsChange(selectedIds.filter((selectedId) => selectedId !== id));
    setExpandedIds((current) => current.filter((expandedId) => expandedId !== id));
    setEditedIds((current) => current.filter((editedId) => editedId !== id));
  }

  function addCase() {
    const next = buildManualGeneratedTestCase(testCases);
    onChange([...testCases, next]);
    onSelectedIdsChange([...selectedIds, next.id]);
    setExpandedIds((current) => [...current, next.id]);
    setEditedIds((current) => [...current, next.id]);
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
    onChange(testCases.filter((testCase) => !selected.has(testCase.id)));
    onSelectedIdsChange([]);
    setExpandedIds((current) => current.filter((id) => !selected.has(id)));
    setEditedIds((current) => current.filter((id) => !selected.has(id)));
  }

  async function copySelected() {
    const selected = testCases.filter((testCase) => selectedSet.has(testCase.id));
    await navigator.clipboard.writeText(JSON.stringify(selected, null, 2));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }

  function clearFilters() {
    setSearch("");
    setTypeFilter("all");
    setPriorityFilter("all");
    setTagFilter("all");
    setSelectedOnly(false);
    setEditedOnly(false);
  }

  return (
    <SectionCard
      title={title}
      description={description}
      action={
        allowAdd ? (
          <Button type="button" variant="secondary" onClick={addCase}>
            <Plus />
            Add Test Case
          </Button>
        ) : null
      }
    >
      <TestCaseSummary
        total={testCases.length}
        selected={selectedIds.length}
        priorityOne={stats.priorityOne}
        invalid={stats.invalid}
        byType={stats.byType}
      />

      <div className="space-y-3 border-b border-border p-4">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex min-w-0 flex-1 flex-col gap-2 md:flex-row md:flex-wrap md:items-center">
            <div className="relative min-w-0 flex-1 md:max-w-sm">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search ID, title, steps, or expected results"
                aria-label="Search generated test cases"
                className="h-8 pl-8"
              />
            </div>
            <select className={selectClass} value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)} aria-label="Filter by type">
              <option value="all">All types</option>
              {types.map((type) => <option key={type} value={type}>{formatEnumLabel(type)}</option>)}
            </select>
            <select className={selectClass} value={priorityFilter} onChange={(event) => setPriorityFilter(event.target.value)} aria-label="Filter by priority">
              <option value="all">All priorities</option>
              <option value="1">Priority 1</option>
              <option value="2">Priority 2</option>
              <option value="3">Priority 3</option>
              <option value="4">Priority 4</option>
            </select>
            {tags.length ? (
              <select className={selectClass} value={tagFilter} onChange={(event) => setTagFilter(event.target.value)} aria-label="Filter by tag">
                <option value="all">All tags</option>
                {tags.map((tag) => <option key={tag} value={tag}>{tag}</option>)}
              </select>
            ) : null}
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
              aria-label="Select all visible test cases"
            />
            Select all visible
            <span className="text-xs font-normal text-muted-foreground">({filteredCases.length})</span>
          </label>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setExpandedIds((current) => [...new Set([...current, ...visibleIds])])}
              disabled={!visibleIds.length}
            >
              Expand all
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setExpandedIds([])} disabled={!expandedIds.length}>
              Collapse all
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={copySelected} disabled={!selectedIds.length}>
              {copied ? <Check /> : <Copy />}
              {copied ? "Copied" : "Copy selected JSON"}
            </Button>
            {allowDelete ? (
              <ConfirmationDialog
                trigger={
                  <Button type="button" size="sm" variant="destructive" disabled={!selectedIds.length}>
                    <Trash2 />
                    Remove selected
                  </Button>
                }
                title="Remove selected test cases?"
                description={`${selectedIds.length} selected test case${selectedIds.length === 1 ? "" : "s"} will be removed from this generated draft.`}
                confirmLabel="Remove cases"
                onConfirm={removeSelected}
              />
            ) : null}
          </div>
        </div>
      </div>

      <div className="space-y-3 bg-muted/20 p-4">
        {filteredCases.length ? filteredCases.map((testCase) => (
          <GeneratedTestCaseReviewCard
            key={testCase.id}
            testCase={testCase}
            onChange={updateCase}
            selected={selectedSet.has(testCase.id)}
            onSelectedChange={(selected) => {
              onSelectedIdsChange(
                selected
                  ? [...new Set([...selectedIds, testCase.id])]
                  : selectedIds.filter((id) => id !== testCase.id),
              );
            }}
            expanded={expandedIds.includes(testCase.id)}
            onExpandedChange={(expanded) => {
              setExpandedIds((current) =>
                expanded
                  ? [...new Set([...current, testCase.id])]
                  : current.filter((id) => id !== testCase.id),
              );
            }}
            edited={editedSet.has(testCase.id)}
            allowDelete={allowDelete}
            onDelete={() => deleteCase(testCase.id)}
          />
        )) : (
          <div className="rounded-xl border border-dashed border-border bg-card p-8 text-center">
            <ListChecks className="mx-auto size-8 text-muted-foreground" />
            <div className="mt-3 font-medium text-foreground">
              {testCases.length ? "No test cases match the current filters." : "No generated test cases yet."}
            </div>
            {filtersActive ? (
              <Button type="button" variant="link" onClick={clearFilters} className="mt-1">
                Clear filters
              </Button>
            ) : null}
          </div>
        )}
      </div>
    </SectionCard>
  );
}

export function GeneratedTestCaseReviewCard({
  testCase,
  onChange,
  selected,
  onSelectedChange,
  expanded: controlledExpanded,
  onExpandedChange,
  edited = false,
  allowDelete = false,
  onDelete,
  heading,
  helperText,
  editLabel = "Edit",
  footer,
  className,
}: {
  testCase: GeneratedTestCase;
  onChange: (testCase: GeneratedTestCase) => void;
  selected?: boolean;
  onSelectedChange?: (selected: boolean) => void;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  edited?: boolean;
  allowDelete?: boolean;
  onDelete?: () => void;
  heading?: string;
  helperText?: string;
  editLabel?: string;
  footer?: ReactNode;
  className?: string;
}) {
  const [internalExpanded, setInternalExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(testCase);
  const [copied, setCopied] = useState(false);
  const expanded = controlledExpanded ?? internalExpanded;
  const validation = validateGeneratedTestCase(testCase);
  const executionSteps = getExecutionSteps(testCase);
  const expectedOutcome = executionSteps.at(-1)?.expectedResult || "No expected outcome supplied.";

  useEffect(() => {
    if (!editing) setDraft(testCase);
  }, [editing, testCase]);

  function setExpanded(expand: boolean) {
    setInternalExpanded(expand);
    onExpandedChange?.(expand);
  }

  function beginEditing() {
    setDraft(testCase);
    setEditing(true);
    setExpanded(true);
  }

  function saveEditing() {
    onChange(normalizeCaseForSave(draft));
    setEditing(false);
  }

  function cancelEditing() {
    setDraft(testCase);
    setEditing(false);
  }

  async function copyJson() {
    await navigator.clipboard.writeText(JSON.stringify(testCase, null, 2));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Card
      className={cn(
        "gap-0 overflow-hidden py-0 shadow-sm transition",
        selected && "ring-2 ring-primary/35",
        !validation.valid && "ring-destructive/30",
        className,
      )}
    >
      {heading || helperText ? (
        <div className="border-b border-border bg-primary/5 px-4 py-3">
          {heading ? <div className="font-semibold text-foreground">{heading}</div> : null}
          {helperText ? <p className="mt-1 text-xs leading-5 text-muted-foreground">{helperText}</p> : null}
        </div>
      ) : null}

      <div className="p-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            {onSelectedChange ? (
              <Checkbox
                checked={selected}
                onCheckedChange={(checked) => onSelectedChange(checked === true)}
                aria-label={`Select ${testCase.id}`}
                className="mt-1"
              />
            ) : null}
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs font-semibold text-primary">{testCase.id}</span>
                {edited ? <ToneBadge tone="draft">Edited</ToneBadge> : null}
                {!validation.valid ? <ToneBadge tone="error">{validation.issues.length} issue{validation.issues.length === 1 ? "" : "s"}</ToneBadge> : null}
              </div>
              <h3 className="mt-1 text-base font-semibold leading-6 text-foreground">{testCase.title || "Untitled test case"}</h3>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <ToneBadge tone="info">{formatEnumLabel(testCase.type || "Unspecified")}</ToneBadge>
                <PriorityBadge priority={testCase.priority} />
                <Badge variant="outline">{executionSteps.length} step{executionSteps.length === 1 ? "" : "s"}</Badge>
                {(testCase.tags ?? []).slice(0, 3).map((tag) => <Badge key={tag} variant="secondary">{tag}</Badge>)}
                {(testCase.tags?.length ?? 0) > 3 ? <Badge variant="secondary">+{(testCase.tags?.length ?? 0) - 3}</Badge> : null}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
              <ChevronDown className={cn("transition-transform", expanded && "rotate-180")} />
              {expanded ? "Collapse" : "Expand details"}
            </Button>
            <Button type="button" size="sm" variant="secondary" onClick={beginEditing} disabled={editing}>
              <Edit3 />
              {editLabel}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={copyJson}>
              {copied ? <Check /> : <Copy />}
              {copied ? "Copied" : "Copy JSON"}
            </Button>
            {allowDelete && onDelete ? (
              <ConfirmationDialog
                trigger={
                  <Button type="button" size="sm" variant="ghost" aria-label={`Delete ${testCase.id}`}>
                    <Trash2 className="text-destructive" />
                    Delete
                  </Button>
                }
                title={`Delete ${testCase.id}?`}
                description="This test case will be removed from the generated draft."
                confirmLabel="Delete test case"
                onConfirm={onDelete}
              />
            ) : null}
          </div>
        </div>

        {!editing ? (
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <PreviewSection label="Preconditions" value={testCase.preconditions || "No preconditions supplied."} />
            <PreviewSection label="Expected outcome" value={expectedOutcome} />
          </div>
        ) : null}
      </div>

      {!validation.valid && !editing ? (
        <div className="border-t border-destructive/20 bg-destructive/5 px-4 py-3">
          <div className="text-xs font-semibold text-destructive">Resolve before publishing</div>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-destructive">
            {validation.issues.map((issue) => <li key={issue}>{issue}</li>)}
          </ul>
        </div>
      ) : null}

      {expanded ? (
        <div className="border-t border-border">
          {editing ? (
            <TestCaseEditForm draft={draft} onChange={setDraft} onSave={saveEditing} onCancel={cancelEditing} />
          ) : (
            <TestCaseDetails testCase={testCase} />
          )}
        </div>
      ) : null}

      {footer ? <div className="border-t border-border bg-muted/30 p-4">{footer}</div> : null}
    </Card>
  );
}

function TestCaseSummary({
  total,
  selected,
  priorityOne,
  invalid,
  byType,
}: {
  total: number;
  selected: number;
  priorityOne: number;
  invalid: number;
  byType: Array<[string, number]>;
}) {
  return (
    <div className="grid gap-3 border-b border-border bg-muted/30 p-4 sm:grid-cols-2 xl:grid-cols-[repeat(4,minmax(120px,160px))_minmax(240px,1fr)]">
      <SummaryMetric label="Generated" value={total} />
      <SummaryMetric label="Selected" value={selected} tone="primary" />
      <SummaryMetric label="Priority 1" value={priorityOne} tone={priorityOne ? "warning" : "neutral"} />
      <SummaryMetric label="Validation issues" value={invalid} tone={invalid ? "error" : "success"} />
      <div className="rounded-xl border border-border bg-card p-3">
        <div className="text-xs font-medium text-muted-foreground">Types</div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {byType.length ? byType.map(([type, count]) => (
            <Badge key={type} variant="secondary">{formatEnumLabel(type)} {count}</Badge>
          )) : <span className="text-sm text-muted-foreground">No types yet</span>}
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

function PreviewSection({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-muted/30 p-3">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      <p className="mt-1 line-clamp-2 whitespace-pre-line text-sm leading-6 text-foreground">{value}</p>
    </div>
  );
}

function TestCaseDetails({ testCase }: { testCase: GeneratedTestCase }) {
  const executionSteps = getExecutionSteps(testCase);
  const expectedOutcome = executionSteps.at(-1)?.expectedResult;
  const traceabilityGroups = [
    ["Acceptance criteria", testCase.relatedAcceptanceCriteria],
    ["Business rules", testCase.relatedBusinessRules],
    ["Modules / dependencies", testCase.relatedModules],
  ] as const;

  return (
    <div className="space-y-5 p-4">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <MetadataItem label="Test Case ID" value={testCase.id} />
        <MetadataItem label="Type" value={formatEnumLabel(testCase.type)} />
        <MetadataItem label="Priority" value={priorityLabel(testCase.priority)} />
        <MetadataItem label="Category" value={testCase.category} />
      </div>

      {testCase.description ? <DetailSection label="Description" value={testCase.description} /> : null}
      <DetailSection label="Preconditions" value={testCase.preconditions || "No preconditions supplied."} />

      <div>
        <div className="mb-2 text-sm font-semibold text-foreground">Steps</div>
        <StepsView steps={executionSteps} />
      </div>

      {testCase.testData ? <DetailSection label="Test Data" value={testCase.testData} /> : null}
      {expectedOutcome ? <DetailSection label="Expected Outcome" value={expectedOutcome} /> : null}

      {(testCase.tags?.length ?? 0) > 0 ? (
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Tags (iTestFlow only)</div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {testCase.tags?.map((tag) => <Badge key={tag} variant="secondary">{tag}</Badge>)}
          </div>
        </div>
      ) : null}

      {traceabilityGroups.some(([, values]) => values?.length) ? (
        <div className="grid gap-3 lg:grid-cols-3">
          {traceabilityGroups.map(([label, values]) => values?.length ? (
            <div key={label} className="rounded-lg border border-border bg-muted/20 p-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
              <ul className="mt-2 space-y-1 text-sm leading-5 text-foreground">
                {values.map((value) => <li key={value}>{value}</li>)}
              </ul>
            </div>
          ) : null)}
        </div>
      ) : null}
    </div>
  );
}

function TestCaseEditForm({
  draft,
  onChange,
  onSave,
  onCancel,
}: {
  draft: GeneratedTestCase;
  onChange: (draft: GeneratedTestCase) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const executionSteps = getExecutionSteps(draft);
  const validation = validateGeneratedTestCase(normalizeCaseForSave(draft));
  const typeOptions = [...new Set([...TEST_CASE_TYPES, draft.type].filter(Boolean))].sort();

  function patch(patchValue: Partial<GeneratedTestCase>) {
    onChange({ ...draft, ...patchValue });
  }

  function updateExecutionSteps(steps: GeneratedTestCase["steps"]) {
    onChange(withExecutionSteps(draft, steps));
  }

  return (
    <div className="space-y-5 bg-muted/15 p-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <EditorField label="Title" className="lg:col-span-2">
          <Input value={draft.title} onChange={(event) => patch({ title: event.target.value })} aria-invalid={!draft.title.trim()} />
        </EditorField>
        <EditorField label="Type">
          <select
            className={cn(selectClass, "h-9 w-full")}
            value={draft.type}
            onChange={(event) => patch({ type: event.target.value })}
          >
            {typeOptions.map((type) => <option key={type} value={type}>{formatEnumLabel(type)}</option>)}
          </select>
        </EditorField>
        <EditorField label="Priority">
          <select
            className={cn(selectClass, "h-9 w-full")}
            value={draft.priority}
            onChange={(event) => patch({ priority: Number(event.target.value) as GeneratedTestCase["priority"] })}
          >
            <option value={1}>1 - Highest</option>
            <option value={2}>2 - High</option>
            <option value={3}>3 - Medium</option>
            <option value={4}>4 - Lowest</option>
          </select>
        </EditorField>
        <EditorField label="Category">
          <Input value={draft.category} onChange={(event) => patch({ category: event.target.value })} />
        </EditorField>
        <EditorField label="Tags (iTestFlow only)">
          <Input
            value={(draft.tags ?? []).join(", ")}
            onChange={(event) => patch({ tags: parseTags(event.target.value) })}
            placeholder="regression, checkout, api"
          />
        </EditorField>
        <EditorField label="Description" className="lg:col-span-2">
          <Textarea value={draft.description} onChange={(event) => patch({ description: event.target.value })} className="min-h-24" />
        </EditorField>
        <EditorField label="Preconditions" className="lg:col-span-2">
          <Textarea
            value={draft.preconditions}
            onChange={(event) => patch({ preconditions: event.target.value })}
            className="min-h-24"
            aria-invalid={!draft.preconditions.trim()}
          />
        </EditorField>
        <EditorField label="Test Data" className="lg:col-span-2">
          <Textarea value={draft.testData ?? ""} onChange={(event) => patch({ testData: event.target.value })} className="min-h-20" />
        </EditorField>
      </div>

      <div>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-sm font-semibold text-foreground">Executable Steps</div>
            <p className="text-xs text-muted-foreground">The preconditions setup row is maintained automatically as step 1.</p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => updateExecutionSteps([...executionSteps, { stepNumber: executionSteps.length + 2, action: "", expectedResult: "" }])}
          >
            <Plus />
            Add step
          </Button>
        </div>
        <StepsEditor steps={executionSteps} onChange={updateExecutionSteps} />
      </div>

      {!validation.valid ? (
        <Callout tone="warning" title="This test case is not ready to publish">
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

function StepsView({ steps }: { steps: GeneratedTestCase["steps"] }) {
  if (!steps.length) {
    return <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">No executable steps supplied.</div>;
  }
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <div className="hidden grid-cols-[52px_minmax(0,1fr)_minmax(0,1fr)] bg-muted px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground md:grid">
        <span>#</span>
        <span>Action</span>
        <span>Expected Result</span>
      </div>
      <div className="divide-y divide-border">
        {steps.map((step, index) => (
          <div key={`${step.stepNumber}-${index}`} className="grid gap-3 p-3 md:grid-cols-[52px_minmax(0,1fr)_minmax(0,1fr)]">
            <span className="font-mono text-xs font-semibold text-muted-foreground">{index + 1}</span>
            <StepValue label="Action" value={step.action} />
            <StepValue label="Expected Result" value={step.expectedResult} />
          </div>
        ))}
      </div>
    </div>
  );
}

function StepsEditor({
  steps,
  onChange,
}: {
  steps: GeneratedTestCase["steps"];
  onChange: (steps: GeneratedTestCase["steps"]) => void;
}) {
  function patchStep(index: number, patch: Partial<GeneratedTestCase["steps"][number]>) {
    onChange(steps.map((step, current) => (current === index ? { ...step, ...patch } : step)));
  }

  function moveStep(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= steps.length) return;
    const next = [...steps];
    const [step] = next.splice(index, 1);
    next.splice(target, 0, step);
    onChange(next);
  }

  if (!steps.length) {
    return <div className="rounded-lg border border-dashed border-border p-5 text-sm text-muted-foreground">Add an executable step to make this case publishable.</div>;
  }

  return (
    <div className="space-y-2">
      {steps.map((step, index) => (
        <div key={`${step.stepNumber}-${index}`} className="rounded-lg border border-border bg-card p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="font-mono text-xs font-semibold text-muted-foreground">Step {index + 1}</span>
            <div className="flex items-center gap-1">
              <Button type="button" size="icon-xs" variant="ghost" onClick={() => moveStep(index, -1)} disabled={index === 0} aria-label={`Move step ${index + 1} up`}>
                <ArrowUp />
              </Button>
              <Button type="button" size="icon-xs" variant="ghost" onClick={() => moveStep(index, 1)} disabled={index === steps.length - 1} aria-label={`Move step ${index + 1} down`}>
                <ArrowDown />
              </Button>
              <Button type="button" size="icon-xs" variant="ghost" onClick={() => onChange(steps.filter((_, current) => current !== index))} aria-label={`Remove step ${index + 1}`}>
                <Trash2 className="text-destructive" />
              </Button>
            </div>
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            <EditorField label="Action">
              <Textarea
                value={step.action}
                onChange={(event) => patchStep(index, { action: event.target.value })}
                className="min-h-20"
                aria-invalid={!step.action.trim()}
              />
            </EditorField>
            <EditorField label="Expected Result">
              <Textarea
                value={step.expectedResult}
                onChange={(event) => patchStep(index, { expectedResult: event.target.value })}
                className="min-h-20"
                aria-invalid={!step.expectedResult.trim()}
              />
            </EditorField>
          </div>
        </div>
      ))}
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

function MetadataItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-muted/20 p-3">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 break-words text-sm font-medium text-foreground">{value || "Not supplied"}</div>
    </div>
  );
}

function DetailSection({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      <p className="mt-1 whitespace-pre-line text-sm leading-6 text-foreground">{value}</p>
    </div>
  );
}

function StepValue({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground md:hidden">{label}</div>
      <p className="whitespace-pre-line text-sm leading-6 text-foreground">{value || "Not supplied"}</p>
    </div>
  );
}

function PriorityBadge({ priority }: { priority: GeneratedTestCase["priority"] }) {
  const tone = priority === 1 ? "error" : priority === 2 ? "warning" : priority === 3 ? "info" : "neutral";
  return <ToneBadge tone={tone}>{priorityLabel(priority)}</ToneBadge>;
}

function priorityLabel(priority: GeneratedTestCase["priority"]) {
  if (priority === 1) return "1 - Highest";
  if (priority === 2) return "2 - High";
  if (priority === 3) return "3 - Medium";
  return "4 - Lowest";
}

function getExecutionSteps(testCase: GeneratedTestCase) {
  return isPreconditionsStep(testCase.steps[0]) ? testCase.steps.slice(1) : testCase.steps;
}

function isPreconditionsStep(step: GeneratedTestCase["steps"][number] | undefined) {
  return step?.action.trim().toLowerCase().startsWith("preconditions");
}

function withExecutionSteps(testCase: GeneratedTestCase, executionSteps: GeneratedTestCase["steps"]): GeneratedTestCase {
  return {
    ...testCase,
    steps: [
      {
        stepNumber: 1,
        action: buildPreconditionsAction(testCase.preconditions),
        expectedResult: PRECONDITIONS_EXPECTED_RESULT,
      },
      ...executionSteps.map((step, index) => ({ ...step, stepNumber: index + 2 })),
    ],
  };
}

function normalizeCaseForSave(testCase: GeneratedTestCase): GeneratedTestCase {
  return withExecutionSteps(testCase, getExecutionSteps(testCase));
}

function buildPreconditionsAction(preconditions: string) {
  return `Preconditions:\n${preconditions}`;
}

function parseTags(value: string) {
  return [...new Set(value.split(",").map((tag) => tag.trim()).filter(Boolean))];
}

function searchableTestCaseText(testCase: GeneratedTestCase) {
  return [
    testCase.id,
    testCase.title,
    testCase.description,
    testCase.preconditions,
    testCase.testData,
    testCase.type,
    testCase.category,
    ...(testCase.tags ?? []),
    ...(testCase.relatedAcceptanceCriteria ?? []),
    ...(testCase.relatedBusinessRules ?? []),
    ...(testCase.relatedModules ?? []),
    ...testCase.steps.flatMap((step) => [step.action, step.expectedResult]),
  ].join(" ").toLowerCase();
}

function buildManualGeneratedTestCase(existingCases: GeneratedTestCase[]): GeneratedTestCase {
  const manualNumbers = existingCases
    .map((testCase) => testCase.id.match(/^TC-MANUAL-(\d+)$/i)?.[1])
    .filter((value): value is string => Boolean(value))
    .map(Number);
  let nextNumber = Math.max(0, ...manualNumbers) + 1;
  const existingIds = new Set(existingCases.map((testCase) => testCase.id));
  let id = `TC-MANUAL-${String(nextNumber).padStart(3, "0")}`;
  while (existingIds.has(id)) {
    nextNumber += 1;
    id = `TC-MANUAL-${String(nextNumber).padStart(3, "0")}`;
  }

  return {
    id,
    title: "New manual test case",
    description: "Manual test case draft.",
    priority: 2,
    type: "regression",
    category: "manual",
    tags: [],
    relatedAcceptanceCriteria: [],
    relatedBusinessRules: [],
    relatedModules: [],
    preconditions: "Required setup is available.",
    testData: "",
    steps: [
      {
        stepNumber: 1,
        action: "Preconditions:\nRequired setup is available.",
        expectedResult: PRECONDITIONS_EXPECTED_RESULT,
      },
    ],
  };
}
