"use client"

import { useState } from "react"
import { Eye, Plus, Search } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { ScoreCard } from "@/components/qa/score-card"
import { cn } from "@/lib/utils"
import type { ContextSuggestion } from "@/types/azure-devops"

export function ContextStorySelector({
  suggestions,
  continueLabel,
}: {
  suggestions: ContextSuggestion[]
  continueLabel: string
}) {
  const [selectedIds, setSelectedIds] = useState(suggestions.map((suggestion) => suggestion.id))
  const [preview, setPreview] = useState<ContextSuggestion | null>(null)
  const [query, setQuery] = useState("")

  const visible = suggestions.filter((suggestion) =>
    `${suggestion.workItemId} ${suggestion.title} ${suggestion.reason}`.toLowerCase().includes(query.toLowerCase())
  )

  const selected = suggestions.filter((suggestion) => selectedIds.includes(suggestion.id))

  return (
    <div className="grid gap-4 xl:grid-cols-[320px_minmax(0,1fr)_320px]">
      <Card className="qa-card">
        <CardHeader>
          <CardTitle className="text-base">Target story</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <Badge variant="outline">Selected story</Badge>
          <h2 className="text-lg font-semibold text-foreground">Azure DevOps work item</h2>
          <p className="leading-6 text-muted-foreground">
            Select a real Azure DevOps work item and context set before running analysis or generation.
          </p>
          <div className="rounded-lg border border-border bg-muted p-3 text-xs text-muted-foreground">
            TODO: Replace placeholder target story copy with selected Azure DevOps work item state.
          </div>
        </CardContent>
      </Card>

      <Card className="qa-card overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-border p-4 md:flex-row md:items-center md:justify-between">
          <div className="relative md:w-80">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search suggested stories" className="h-8 pl-8" />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => setSelectedIds(suggestions.map((item) => item.id))}>Select All</Button>
            <Button size="sm" variant="outline" onClick={() => setSelectedIds([])}>Deselect All</Button>
            <Button size="sm" variant="outline"><Search className="size-3.5" />Search more stories</Button>
            <Button size="sm"><Plus className="size-3.5" />Add selected</Button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <Table containerClassName="max-h-[70vh] overflow-y-auto overscroll-contain">
            <TableHeader className="sticky top-0 z-20 bg-card">
              <TableRow>
                <TableHead className="w-10">Select</TableHead>
                <TableHead>Work Item ID</TableHead>
                <TableHead className="min-w-[240px]">Title</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Relationship</TableHead>
                <TableHead>Relevance</TableHead>
                <TableHead className="min-w-[280px]">Reason</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((suggestion) => {
                const isSelected = selectedIds.includes(suggestion.id)
                return (
                  <TableRow key={suggestion.id} className={cn("qa-table-row", isSelected && "qa-table-row-selected")}>
                    <TableCell>
                      <Checkbox
                        checked={isSelected}
                        onCheckedChange={(checked) =>
                          setSelectedIds((current) =>
                            checked ? [...current, suggestion.id] : current.filter((id) => id !== suggestion.id)
                          )
                        }
                        aria-label={`Select ${suggestion.workItemId}`}
                      />
                    </TableCell>
                    <TableCell className="font-mono text-xs font-semibold text-primary">{suggestion.workItemId}</TableCell>
                    <TableCell className="font-medium text-foreground">{suggestion.title}</TableCell>
                    <TableCell><Badge variant="secondary">{suggestion.type}</Badge></TableCell>
                    <TableCell><Badge variant="outline">{suggestion.relationship}</Badge></TableCell>
                    <TableCell>{suggestion.relevance}%</TableCell>
                    <TableCell className="text-muted-foreground">{suggestion.reason}</TableCell>
                    <TableCell className="text-right">
                      <Button size="icon-sm" variant="ghost" onClick={() => setPreview(suggestion)} aria-label={`Preview ${suggestion.workItemId}`}>
                        <Eye className="size-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      </Card>

      <div className="space-y-4">
        <ScoreCard title="Context relevance" score={Math.round(selected.reduce((sum, item) => sum + item.relevance, 0) / Math.max(selected.length, 1))} description="Average relevance from current RAG suggestions." />
        <Card className="qa-card">
          <CardHeader>
            <CardTitle className="text-base">Context summary</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            <p>{selected.length} stories selected for this run.</p>
            <ul className="space-y-2">
              {selected.map((item) => (
                <li key={item.id} className="rounded-lg border border-border p-2">
                  <span className="font-mono text-xs text-primary">{item.workItemId}</span> {item.title}
                </li>
              ))}
            </ul>
            <Button className="w-full">{continueLabel}</Button>
          </CardContent>
        </Card>
      </div>

      <Sheet open={Boolean(preview)} onOpenChange={(open) => !open && setPreview(null)}>
        <SheetContent className="sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>{preview?.workItemId} - {preview?.title}</SheetTitle>
          </SheetHeader>
          <div className="space-y-4 p-4 text-sm leading-6 text-muted-foreground">
            <p>{preview?.reason}</p>
            <div className="rounded-lg border border-border bg-muted p-3">
              TODO: Load full Azure DevOps story body, comments, and links for preview.
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  )
}

