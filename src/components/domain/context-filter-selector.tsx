"use client"

import { useState } from "react"
import { Plus, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

type ContextFilterSelectorProps = {
  title: string
  description: string
  options: string[]
  selectedValues: string[]
  customPlaceholder: string
  duplicateMessage: string
  onChange: (values: string[]) => void
  optionGridClassName?: string
}

export function ContextFilterSelector({
  title,
  description,
  options,
  selectedValues,
  customPlaceholder,
  duplicateMessage,
  onChange,
  optionGridClassName = "sm:grid-cols-2",
}: ContextFilterSelectorProps) {
  const [customValue, setCustomValue] = useState("")
  const [customError, setCustomError] = useState<string | null>(null)
  const selectedCustomValues = selectedValues.filter((value) => !hasFilterValue(options, value))

  function toggleValue(value: string, selected: boolean) {
    const next = selected
      ? uniqueFilterValues([...selectedValues, value])
      : selectedValues.filter((item) => !isSameFilterValue(item, value))
    onChange(next)
    setCustomError(null)
  }

  function addCustomValue() {
    const trimmed = customValue.trim()
    if (!trimmed) return

    const optionMatch = options.find((option) => isSameFilterValue(option, trimmed))
    const valueToAdd = optionMatch ?? trimmed
    if (hasFilterValue(selectedValues, valueToAdd)) {
      setCustomError(duplicateMessage)
      return
    }

    onChange(uniqueFilterValues([...selectedValues, valueToAdd]))
    setCustomValue("")
    setCustomError(null)
  }

  return (
    <div className="rounded-md border border-[#DCDFE4] bg-white p-3">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-sm font-semibold text-[#172B4D]">{title}</div>
          <div className="mt-1 text-xs leading-5 text-[#626F86]">{description}</div>
        </div>
        <div className="text-xs text-[#626F86]">{selectedValues.length} selected</div>
      </div>

      <div className={`mt-3 grid gap-2 ${optionGridClassName}`}>
        {options.map((option) => {
          const checked = hasFilterValue(selectedValues, option)
          return (
            <Label key={option} className="flex min-h-9 items-center gap-3 rounded-md border border-[#DCDFE4] bg-white px-3 py-2 text-sm text-[#172B4D]">
              <Checkbox checked={checked} onCheckedChange={(next) => toggleValue(option, next === true)} />
              <span>{option}</span>
            </Label>
          )
        })}
      </div>

      {selectedCustomValues.length ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {selectedCustomValues.map((value) => (
            <span key={value} className="inline-flex min-h-8 items-center gap-2 rounded-md border border-[#0C66E4]/25 bg-[#E9F2FF] px-2.5 py-1 text-xs font-medium text-[#0C66E4]">
              {value}
              <button
                type="button"
                className="rounded-sm p-0.5 text-[#0C66E4] hover:bg-white/70"
                onClick={() => toggleValue(value, false)}
                title={`Remove ${value}`}
              >
                <X className="size-3.5" />
              </button>
            </span>
          ))}
        </div>
      ) : null}

      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <Input
          className="h-10 border-[#DCDFE4] bg-white text-[#172B4D]"
          value={customValue}
          onChange={(event) => {
            setCustomValue(event.target.value)
            setCustomError(null)
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault()
              addCustomValue()
            }
          }}
          placeholder={customPlaceholder}
        />
        <Button
          type="button"
          variant="outline"
          className="h-10 shrink-0 border-[#DCDFE4] bg-white px-3 text-[#172B4D] hover:bg-[#F7F8F9]"
          onClick={addCustomValue}
        >
          <Plus className="size-4" />
          Add
        </Button>
      </div>
      {customError ? <div className="mt-2 text-xs text-red-700">{customError}</div> : null}
    </div>
  )
}

function uniqueFilterValues(values: string[]) {
  const seen = new Set<string>()
  const unique: string[] = []

  for (const value of values) {
    const trimmed = value.trim()
    const key = trimmed.toLowerCase()
    if (!trimmed || seen.has(key)) continue
    seen.add(key)
    unique.push(trimmed)
  }

  return unique
}

function hasFilterValue(values: string[], value: string) {
  return values.some((item) => isSameFilterValue(item, value))
}

function isSameFilterValue(first: string, second: string) {
  return first.trim().toLowerCase() === second.trim().toLowerCase()
}
