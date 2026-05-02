"use client"

import { ArrowDown, ArrowUp, Check, Plus, Trash2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import type { TestStep } from "@/types/test-cases"

export function InlineEditableSteps({
  steps,
  onChange,
}: {
  steps: TestStep[]
  onChange: (steps: TestStep[]) => void
}) {
  function updateStep(id: string, patch: Partial<TestStep>) {
    onChange(steps.map((step) => (step.id === id ? { ...step, ...patch } : step)))
  }

  function addStep() {
    onChange([
      ...steps,
      {
        id: `S${steps.length + 1}`,
        action: "New step action",
        expected: "Expected result",
      },
    ])
  }

  function removeStep(id: string) {
    onChange(steps.filter((step) => step.id !== id))
  }

  function moveStep(index: number, direction: -1 | 1) {
    const target = index + direction
    if (target < 0 || target >= steps.length) return
    const next = [...steps]
    const [item] = next.splice(index, 1)
    next.splice(target, 0, item)
    onChange(next)
  }

  return (
    <div className="space-y-3">
      {steps.map((step, index) => (
        <div key={step.id} className="rounded-lg border border-[#EBECF0] bg-white p-2">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="font-mono text-xs font-semibold text-[#626F86]">Step {index + 1}</span>
            <div className="flex items-center gap-1">
              <Button type="button" variant="ghost" size="icon-xs" onClick={() => moveStep(index, -1)} aria-label="Move step up">
                <ArrowUp className="size-3" />
              </Button>
              <Button type="button" variant="ghost" size="icon-xs" onClick={() => moveStep(index, 1)} aria-label="Move step down">
                <ArrowDown className="size-3" />
              </Button>
              <Button type="button" variant="ghost" size="icon-xs" onClick={() => removeStep(step.id)} aria-label="Remove step">
                <Trash2 className="size-3 text-[#AE2E24]" />
              </Button>
            </div>
          </div>
          <div className="grid gap-2">
            <Textarea
              value={step.action}
              onChange={(event) => updateStep(step.id, { action: event.target.value })}
              aria-label={`Step ${index + 1} action`}
              className="min-h-16 text-xs"
            />
            <Input
              value={step.expected}
              onChange={(event) => updateStep(step.id, { expected: event.target.value })}
              aria-label={`Step ${index + 1} expected result`}
              className="h-8 text-xs"
            />
          </div>
        </div>
      ))}
      <Button type="button" size="sm" variant="outline" onClick={addStep}>
        <Plus className="size-3.5" />
        Add step
      </Button>
      <span className="sr-only" aria-live="polite">
        <Check className="size-3" /> Steps editable
      </span>
    </div>
  )
}
