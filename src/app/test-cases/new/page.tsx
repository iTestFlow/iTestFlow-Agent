"use client"

import { Plus } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { ContentShell } from "@/components/layout/content-shell"

export default function NewTestCasePage() {
  return (
    <ContentShell
      title="Add New Test Case"
      description="Create a manual draft case for the selected live Azure DevOps work item before publishing to Azure Test Plans."
    >
      <Card className="qa-card max-w-4xl">
        <CardHeader><CardTitle className="text-base">Manual test case details</CardTitle></CardHeader>
        <CardContent className="grid gap-4">
          <Field label="Title"><Input placeholder="Enter test case title" /></Field>
          <div className="grid gap-4 md:grid-cols-2">
            <SelectField label="Type" values={["Functional", "Negative", "Integration", "Regression", "Accessibility"]} />
            <SelectField label="Priority" values={["P0", "P1", "P2", "P3"]} />
            <SelectField label="Severity" values={["Critical", "High", "Medium", "Low"]} />
            <SelectField label="Automation suitability" values={["High", "Medium", "Low", "Manual only"]} />
          </div>
          <Field label="Preconditions"><Textarea placeholder="Enter preconditions" /></Field>
          <Field label="Steps"><Textarea className="min-h-32" placeholder="1. Enter the first action&#10;2. Enter the next action" /></Field>
          <Field label="Expected result"><Textarea placeholder="Enter expected result" /></Field>
          <Field label="Test data"><Textarea placeholder="Enter test data" /></Field>
          <Field label="Tags"><Input placeholder="tag-one, tag-two" /></Field>
          <Button className="w-fit" onClick={() => toast.success("Manual test case saved locally for live publish testing")}>
            <Plus className="size-4" />
            Add test case
          </Button>
        </CardContent>
      </Card>
    </ContentShell>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="grid gap-2"><Label>{label}</Label>{children}</div>
}

function SelectField({ label, values }: { label: string; values: string[] }) {
  return (
    <Field label={label}>
      <Select defaultValue={values[0]}>
        <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
        <SelectContent>{values.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent>
      </Select>
    </Field>
  )
}
