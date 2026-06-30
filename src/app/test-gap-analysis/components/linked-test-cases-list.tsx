"use client";

import { useId, useState } from "react";
import { ChevronDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { EmptyBlock, SectionCard } from "@/components/workflow/test-intelligence-shared";
import type { ExistingLinkedTestCase } from "@/components/workflow/test-intelligence-types";

/* Collapsible list of Azure DevOps test cases already linked to the story. */

export function ExistingLinkedTestCasesList({ linkedTestCases }: { linkedTestCases: ExistingLinkedTestCase[] }) {
  const [open, setOpen] = useState(false);
  const listId = useId();

  return (
    <SectionCard
      title="Linked Test Cases"
      action={
        <Button
          type="button"
          variant="secondary"
          className="h-8 px-3"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen((current) => !current)}
        >
          <ChevronDown className={cn("h-4 w-4 transition-transform duration-200 motion-reduce:transition-none", open && "rotate-180")} aria-hidden="true" />
          {open ? "Hide" : "Show"}
        </Button>
      }
    >
      {open && linkedTestCases.length ? (
        <div id={listId} className="divide-y divide-border">
          {linkedTestCases.map((testCase) => (
            <div key={testCase.id} className="grid gap-3 p-4 md:grid-cols-[140px_1fr_120px]">
              <span className="font-mono text-xs text-primary">{testCase.id}</span>
              <div>
                <div className="font-medium text-foreground">{testCase.title}</div>
                <div className="mt-1 text-xs text-muted-foreground">{testCase.testType ?? "Test Case"}</div>
              </div>
              <span className="text-sm text-muted-foreground">{testCase.steps?.length ?? 0} steps</span>
            </div>
          ))}
        </div>
      ) : open ? (
        <div id={listId}>
          <EmptyBlock message="No TestedBy / Tests linked Azure DevOps test cases were found for this story." />
        </div>
      ) : null}
    </SectionCard>
  );
}
