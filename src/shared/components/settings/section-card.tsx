"use client"

import * as React from "react"
import { Eye, EyeOff } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export type StatusTone = "success" | "warning" | "destructive" | "muted" | "info"
export type Provider = "openai" | "gemini" | "anthropic"

/** A titled settings card with an optional right-aligned action/badge slot. */
export function SectionCard({
  title,
  description,
  action,
  children,
  className,
  contentClassName,
}: {
  title: string
  description?: React.ReactNode
  action?: React.ReactNode
  children: React.ReactNode
  className?: string
  contentClassName?: string
}) {
  return (
    <Card className={className}>
      <CardHeader className="border-b">
        <CardTitle className="text-base">{title}</CardTitle>
        {description ? (
          <CardDescription className="text-xs leading-5">{description}</CardDescription>
        ) : null}
        {action ? <CardAction>{action}</CardAction> : null}
      </CardHeader>
      <CardContent className={cn("space-y-5 pt-5", contentClassName)}>{children}</CardContent>
    </Card>
  )
}

/** Labelled form field with optional helper text below the control. */
export function Field({
  label,
  description,
  htmlFor,
  children,
}: {
  label: string
  description?: React.ReactNode
  htmlFor?: string
  children: React.ReactNode
}) {
  return (
    <div className="block">
      <label htmlFor={htmlFor} className="mb-2 block text-sm font-medium text-foreground">
        {label}
      </label>
      {children}
      {description ? (
        <div className="mt-2 text-xs leading-5 text-muted-foreground">{description}</div>
      ) : null}
    </div>
  )
}

/**
 * Secret input with its own show/hide toggle and a "replace" affordance. When a
 * value is already saved and untouched, it shows a masked read-only state with a
 * Replace button; editing reveals an empty input. Leaving the field empty signals
 * "keep the saved secret" to the parent.
 */
export function SecretField({
  label,
  description,
  value,
  onChange,
  placeholder,
  hasSaved,
  id,
}: {
  label: string
  description?: React.ReactNode
  value: string
  onChange: (value: string) => void
  placeholder: string
  hasSaved: boolean
  id?: string
}) {
  const generatedId = React.useId()
  const inputId = id ?? generatedId
  const labelId = `${inputId}-label`
  const [replacing, setReplacing] = React.useState(false)
  const [reveal, setReveal] = React.useState(false)
  const editing = !hasSaved || replacing || value.length > 0

  return (
    <div className="block">
      <label id={labelId} htmlFor={editing ? inputId : undefined} className="mb-2 block text-sm font-medium text-foreground">
        {label}
      </label>
      {editing ? (
        <div className="relative">
          <Input
            id={inputId}
            className="h-11 border-input bg-card pr-10 text-foreground"
            type={reveal ? "text" : "password"}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder={placeholder}
            autoComplete="off"
          />
          <button
            type="button"
            onClick={() => setReveal((current) => !current)}
            className="absolute inset-y-0 right-2 flex items-center text-muted-foreground hover:text-foreground"
            aria-label={reveal ? `Hide ${label}` : `Show ${label}`}
          >
            {reveal ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
      ) : (
        <div
          role="group"
          aria-labelledby={labelId}
          className="flex h-11 items-center justify-between rounded-md border border-input bg-card px-3"
        >
          <span className="text-sm text-muted-foreground">************ Saved</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={`Replace ${label}`}
            onClick={() => setReplacing(true)}
          >
            Replace
          </Button>
        </div>
      )}
      {hasSaved && editing ? (
        <button
          type="button"
          className="mt-2 text-xs font-medium text-primary"
          onClick={() => {
            onChange("")
            setReplacing(false)
          }}
        >
          Keep saved secret
        </button>
      ) : null}
      {description ? (
        <div className="mt-2 text-xs leading-5 text-muted-foreground">{description}</div>
      ) : null}
    </div>
  )
}

const TONE_BADGE_CLASS: Record<StatusTone, string> = {
  success: "border-success/30 bg-success/10 text-success",
  warning: "border-warning/40 bg-warning/15 text-warning-foreground dark:text-warning",
  destructive: "border-destructive/30 bg-destructive/10 text-destructive",
  muted: "border-border bg-muted text-muted-foreground",
  info: "border-info/30 bg-info/10 text-info",
}

/** A status pill colored by tone, used in section headers. */
export function StatusBadge({
  tone,
  label,
  className,
}: {
  tone: StatusTone
  label: string
  className?: string
}) {
  return (
    <Badge variant="outline" className={cn("font-medium", TONE_BADGE_CLASS[tone], className)}>
      {label}
    </Badge>
  )
}

export function defaultBaseUrlPlaceholder(provider: Provider) {
  switch (provider) {
    case "openai":
      return "https://api.openai.com/v1"
    case "gemini":
      return "https://generativelanguage.googleapis.com/v1beta"
    case "anthropic":
      return "https://api.anthropic.com"
  }
}
