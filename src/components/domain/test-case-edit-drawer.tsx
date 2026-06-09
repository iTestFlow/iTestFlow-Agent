"use client"

import { useEffect, useState } from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Sheet,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Textarea } from "@/components/ui/textarea"
import { InlineEditableSteps } from "@/components/qa/inline-editable-steps"
import type {
  AutomationSuitability,
  GeneratedTestCase,
  TestCaseType,
  TestPriority,
  TestSeverity,
} from "@/types/test-cases"

const testTypes: TestCaseType[] = ["Functional", "Negative", "Integration", "Regression", "Accessibility"]
const priorities: TestPriority[] = ["P0", "P1", "P2", "P3"]
const severities: TestSeverity[] = ["Critical", "High", "Medium", "Low"]
const automationValues: AutomationSuitability[] = ["High", "Medium", "Low", "Manual only"]

export function TestCaseEditDrawer({
  testCase,
  open,
  onOpenChange,
  onSave,
}: {
  testCase: GeneratedTestCase | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSave: (testCase: GeneratedTestCase) => void
}) {
  const [draft, setDraft] = useState<GeneratedTestCase | null>(testCase)

  useEffect(() => {
    setDraft(testCase)
  }, [testCase])

  function patch(patchValue: Partial<GeneratedTestCase>) {
    setDraft((current) => (current ? { ...current, ...patchValue } : current))
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full p-0 sm:max-w-3xl">
        <SheetHeader className="border-b border-border p-5">
          <div className="flex items-center gap-2">
            {draft ? <Badge variant="outline">{draft.id}</Badge> : null}
            {draft ? <Badge variant="secondary">{draft.type}</Badge> : null}
          </div>
          <SheetTitle>Edit test case details</SheetTitle>
        </SheetHeader>

        {draft ? (
          <>
            <ScrollArea className="h-[calc(100vh-150px)]">
              <div className="grid gap-4 p-5">
                <Field label="Title">
                  <Input value={draft.title} onChange={(event) => patch({ title: event.target.value })} />
                </Field>

                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Type">
                    <Select value={draft.type} onValueChange={(value) => patch({ type: value as TestCaseType })}>
                      <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                      <SelectContent>{testTypes.map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}</SelectContent>
                    </Select>
                  </Field>
                  <Field label="Priority">
                    <Select value={draft.priority} onValueChange={(value) => patch({ priority: value as TestPriority })}>
                      <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                      <SelectContent>{priorities.map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}</SelectContent>
                    </Select>
                  </Field>
                  <Field label="Severity">
                    <Select value={draft.severity} onValueChange={(value) => patch({ severity: value as TestSeverity })}>
                      <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                      <SelectContent>{severities.map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}</SelectContent>
                    </Select>
                  </Field>
                  <Field label="Automation suitability">
                    <Select value={draft.automationSuitability} onValueChange={(value) => patch({ automationSuitability: value as AutomationSuitability })}>
                      <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                      <SelectContent>{automationValues.map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}</SelectContent>
                    </Select>
                  </Field>
                </div>

                <Field label="Preconditions">
                  <Textarea value={draft.preconditions} onChange={(event) => patch({ preconditions: event.target.value })} />
                </Field>

                <Field label="Steps">
                  <InlineEditableSteps steps={draft.steps} onChange={(steps) => patch({ steps })} />
                </Field>

                <Field label="Expected result">
                  <Textarea value={draft.expectedResult} onChange={(event) => patch({ expectedResult: event.target.value })} />
                </Field>

                <Field label="Test data">
                  <Textarea value={draft.testData} onChange={(event) => patch({ testData: event.target.value })} />
                </Field>

                <Field label="Tags">
                  <Input value={draft.tags.join(", ")} onChange={(event) => patch({ tags: event.target.value.split(",").map((tag) => tag.trim()).filter(Boolean) })} />
                </Field>
              </div>
            </ScrollArea>
            <SheetFooter className="border-t border-border">
              <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button onClick={() => { onSave(draft); onOpenChange(false) }}>Save changes</Button>
            </SheetFooter>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-2">
      <Label>{label}</Label>
      {children}
    </div>
  )
}

