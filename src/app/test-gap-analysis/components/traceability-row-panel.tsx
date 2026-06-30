"use client";

import type { ReactNode } from "react";
import { ExternalLink } from "lucide-react";

import { AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { ToneBadge } from "@/components/workflow/test-intelligence-shared";
import type { ExistingTraceabilityRow } from "@/components/workflow/test-intelligence-types";

import {
  coverageTone,
  traceabilityRequirementTitle,
  traceabilitySourceContext,
  traceabilitySourceLinks,
  traceabilitySourceSummary,
  traceabilitySourceText,
  type TraceabilitySourceContextValue,
  type TraceabilitySourceLink,
} from "../lib/traceability-text";
import { TestCaseChips } from "./shared-chips";

/* The Traceability Matrix is secondary evidence/audit detail. Each row is a
 * collapsed Accordion item (slim by default) that expands to show source
 * context, missing coverage, recommended action, evidence, and linked cases. */

const MATRIX_GRID_COLUMNS = "lg:grid-cols-[minmax(280px,1.8fr)_130px_110px_70px]";

export function TraceabilityMatrixColumnHeader() {
  return (
    <div className={`hidden rounded-md px-4 pr-10 text-xs font-semibold uppercase tracking-normal text-muted-foreground lg:grid ${MATRIX_GRID_COLUMNS} lg:items-center lg:gap-3`}>
      <span>Requirement</span>
      <span>Coverage</span>
      <span>Linked Cases</span>
      <span>Min</span>
    </div>
  );
}

export function TraceabilityRowPanel({
  row,
  highlighted,
}: {
  row: ExistingTraceabilityRow;
  highlighted: boolean;
}) {
  const linkedCaseCount = row.linkedTestCaseIds.length;
  const sourceLabel = traceabilitySourceSummary(row);
  const sourceContext = traceabilitySourceContext(row);
  const sourceText = traceabilitySourceText(row);
  const sourceLinks = traceabilitySourceLinks(row);
  const requirementTitle = traceabilityRequirementTitle(row);
  const actionNeeded = row.coverageStatus !== "Covered";
  const showRequirementInDetails = row.requirementText.length > 180 || row.coverageStatus === "Not covered" || row.coverageStatus === "Needs review";
  const hasEvidence = row.evidenceSummary.trim().length > 0;
  const actionLabel = actionNeeded ? "Recommended action" : "Coverage note";

  return (
    <AccordionItem value={row.id} className={highlighted ? "border-primary/40 ring-1 ring-primary/20" : undefined}>
      <AccordionTrigger className={`items-start px-4 py-2 hover:bg-muted/40 lg:items-center`}>
        <div className={`grid w-full min-w-0 gap-x-3 gap-y-1 pr-3 text-left ${MATRIX_GRID_COLUMNS} lg:items-center`}>
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <span className="font-mono text-xs font-semibold text-primary">{row.id}</span>
              <ToneBadge tone="neutral">{sourceLabel}</ToneBadge>
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{requirementTitle}</span>
            </div>
            {row.recommendedAction ? (
              <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
                <span className="font-medium text-foreground/80">{actionNeeded ? "Action: " : "Note: "}</span>
                {row.recommendedAction}
              </p>
            ) : null}
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground lg:hidden">
              <ToneBadge tone={coverageTone(row.coverageStatus)}>{row.coverageStatus}</ToneBadge>
              <span className="tabular-nums">{linkedCaseCount} linked case{linkedCaseCount === 1 ? "" : "s"}</span>
              <span className="tabular-nums">Min {row.recommendedMinimumTestCount}</span>
            </div>
          </div>
          <div className="hidden lg:block">
            <ToneBadge tone={coverageTone(row.coverageStatus)}>{row.coverageStatus}</ToneBadge>
          </div>
          <div className="hidden text-xs text-muted-foreground lg:block tabular-nums">{linkedCaseCount} linked</div>
          <div className="hidden text-xs text-muted-foreground lg:block tabular-nums">{row.recommendedMinimumTestCount}</div>
        </div>
      </AccordionTrigger>
      <AccordionContent className="bg-muted/10">
        <div className="space-y-4">
          <TraceabilitySourceContext context={sourceContext} />
          {sourceText ? <TraceabilityDetailSection label="Source text" value={sourceText} tone="muted" /> : null}
          <TraceabilitySourceLinks links={sourceLinks} />

          {row.coverageStatus === "Covered" ? (
            <>
              <TraceabilityDetailSection label="Evidence" value={row.evidenceSummary || "No evidence supplied."} tone="muted" />
              <LinkedTestCasesSection ids={row.linkedTestCaseIds} />
              {row.recommendedAction ? (
                <TraceabilityDetailSection label={actionLabel} value={row.recommendedAction} tone="muted" />
              ) : null}
              {showRequirementInDetails ? <TraceabilityRequirementSection value={row.requirementText} /> : null}
            </>
          ) : (
            <>
              {row.missingCoverage ? <MissingCoverageBlock value={row.missingCoverage} /> : null}
              <RecommendedActionBlock row={row} />
              {row.coverageStatus === "Not covered" || row.coverageStatus === "Needs review" ? (
                <TraceabilityRequirementSection value={row.requirementText} />
              ) : null}
              {hasEvidence ? <TraceabilityDetailSection label="Evidence" value={row.evidenceSummary} tone="muted" /> : null}
              {row.coverageStatus === "Partially covered" ? (
                showRequirementInDetails ? <TraceabilityRequirementSection value={row.requirementText} /> : null
              ) : null}
              <LinkedTestCasesSection ids={row.linkedTestCaseIds} />
            </>
          )}
        </div>
      </AccordionContent>
    </AccordionItem>
  );
}

function TraceabilitySourceContext({ context }: { context: TraceabilitySourceContextValue | null }) {
  if (!context) return null;

  return (
    <div>
      <TraceabilitySectionLabel>Source context</TraceabilitySectionLabel>
      <p className="mt-1 text-sm leading-6 text-muted-foreground">
        {context.category}: <span className="text-foreground">{context.reference}</span>
      </p>
    </div>
  );
}

function TraceabilitySourceLinks({ links }: { links: TraceabilitySourceLink[] }) {
  if (!links.length) return null;

  return (
    <div>
      <TraceabilitySectionLabel>Source links</TraceabilitySectionLabel>
      <div className="mt-2 flex flex-wrap gap-2">
        {links.map((link) => (
          <a
            key={link.href}
            href={link.href}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs font-medium text-primary hover:bg-muted"
          >
            <ExternalLink className="size-3.5" />
            {link.label}
          </a>
        ))}
      </div>
    </div>
  );
}

function TraceabilityRequirementSection({ value }: { value: string }) {
  return <TraceabilityDetailSection label="Requirement" value={value} />;
}

function RecommendedActionBlock({ row }: { row: ExistingTraceabilityRow }) {
  return (
    <div className="rounded-md border border-primary/20 bg-primary/5 p-3">
      <TraceabilitySectionLabel>Recommended action</TraceabilitySectionLabel>
      <p className="mt-1 text-sm leading-6 text-primary">{row.recommendedAction}</p>
    </div>
  );
}

function TraceabilityDetailSection({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "muted" | "primary";
}) {
  const valueClass = {
    default: "text-foreground",
    muted: "text-muted-foreground",
    primary: "text-primary",
  }[tone];

  return (
    <div>
      <TraceabilitySectionLabel>{label}</TraceabilitySectionLabel>
      <p className={`mt-1 text-sm leading-6 ${valueClass}`}>{value}</p>
    </div>
  );
}

function MissingCoverageBlock({ value }: { value: string }) {
  return (
    <div className="rounded-md border border-destructive/25 border-l-4 bg-destructive/5 p-3">
      <TraceabilitySectionLabel>Missing coverage</TraceabilitySectionLabel>
      <p className="mt-1 text-sm leading-6 text-foreground">{value}</p>
    </div>
  );
}

function LinkedTestCasesSection({ ids }: { ids: string[] }) {
  return (
    <div>
      <TraceabilitySectionLabel>Linked test cases</TraceabilitySectionLabel>
      <div className="mt-2">
        <TestCaseChips ids={ids} />
      </div>
    </div>
  );
}

function TraceabilitySectionLabel({ children }: { children: ReactNode }) {
  return <div className="text-xs font-semibold uppercase tracking-normal text-muted-foreground">{children}</div>;
}
