"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import { EmptyBlock, SectionCard } from "@/components/workflow/test-intelligence-shared";
import type { ExistingLinkedTestCase } from "@/components/workflow/test-intelligence-types";

/* Collapsible list of Azure DevOps test cases already linked to the story. */

export function ExistingLinkedTestCasesList({ linkedTestCases }: { linkedTestCases: ExistingLinkedTestCase[] }) {
  const [open, setOpen] = useState(false);

  return (
    <SectionCard
      title="Linked Test Cases"
      action={
        <Button
          type="button"
          variant="secondary"
          className="h-8 px-3"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          <ChevronDown className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} />
          {open ? "Hide" : "Show"}
        </Button>
      }
    >
      {open && linkedTestCases.length ? (
        <div className="divide-y divide-border">
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
        <EmptyBlock message="No TestedBy / Tests linked Azure DevOps test cases were found for this story." />
      ) : null}
    </SectionCard>
  );
}
