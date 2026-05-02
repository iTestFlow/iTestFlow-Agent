"use client"

import { useEffect, useRef, useState } from "react"
import { Check, Pencil, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"

export function InlineEditableText({
  value,
  onChange,
  multiline = false,
  ariaLabel = "Editable text",
}: {
  value: string
  onChange: (value: string) => void
  multiline?: boolean
  ariaLabel?: string
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null)

  useEffect(() => {
    setDraft(value)
  }, [value])

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
    }
  }, [editing])

  function save() {
    onChange(draft.trim() || value)
    setEditing(false)
  }

  function cancel() {
    setDraft(value)
    setEditing(false)
  }

  if (!editing) {
    return (
      <button
        type="button"
        className="group flex w-full items-start justify-between gap-2 rounded-md px-1 py-1 text-left text-sm leading-5 text-[#172B4D] hover:bg-[#F1F2F4] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => setEditing(true)}
        aria-label={`Edit ${ariaLabel}`}
      >
        <span>{value}</span>
        <Pencil className="mt-0.5 size-3.5 shrink-0 text-[#626F86] opacity-0 group-hover:opacity-100" aria-hidden="true" />
      </button>
    )
  }

  const Control = multiline ? Textarea : Input

  return (
    <div className="space-y-2">
      <Control
        ref={inputRef as never}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") cancel()
          if (!multiline && event.key === "Enter") save()
        }}
        aria-label={ariaLabel}
        className={multiline ? "min-h-20" : "h-8"}
      />
      <div className="flex items-center gap-1">
        <Button type="button" size="icon-xs" onClick={save} aria-label="Save edit">
          <Check className="size-3" />
        </Button>
        <Button type="button" size="icon-xs" variant="ghost" onClick={cancel} aria-label="Cancel edit">
          <X className="size-3" />
        </Button>
        {draft !== value ? <span className="text-xs text-[#626F86]">Unsaved</span> : null}
      </div>
    </div>
  )
}

