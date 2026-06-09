"use client"

import { useState } from "react"
import { Clipboard, Send } from "lucide-react"
import { toast } from "sonner"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Textarea } from "@/components/ui/textarea"
import { ConfirmationDialog } from "@/components/qa/confirmation-dialog"
import type { FinalCommentMetadata } from "@/types/requirements"

export function FinalCommentPreview({
  initialComment,
  metadata,
  projectName = "Selected Azure DevOps project",
  targetStoryLabel,
}: {
  initialComment: string
  metadata: FinalCommentMetadata
  projectName?: string
  targetStoryLabel?: string
}) {
  const [comment, setComment] = useState(initialComment)
  const [checks, setChecks] = useState({
    project: true,
    selectedOnly: true,
    reviewed: false,
  })

  const ready = checks.project && checks.selectedOnly && checks.reviewed

  function pushComment() {
    // TODO: Connect to Azure DevOps comment API with selected findings only.
    toast.success("Azure DevOps comment queued", {
      description: "Only selected and approved findings would be pushed.",
    })
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
      <Card className="qa-card">
        <CardHeader>
          <CardTitle className="text-base">Final editable comment</CardTitle>
        </CardHeader>
        <CardContent>
          <Textarea
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            className="min-h-[420px] font-mono text-sm leading-6"
            aria-label="Final Azure DevOps comment preview"
          />
        </CardContent>
      </Card>

      <div className="space-y-4">
        <Card className="qa-card">
          <CardHeader>
            <CardTitle className="text-base">Comment metadata</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <Info label="Project" value={projectName} />
            <Info label="Target story" value={targetStoryLabel ?? metadata.targetStoryId} />
            <Info label="Selected findings" value={`${metadata.findingsCount}`} />
            <Info label="Context stories" value={`${metadata.contextStoriesCount}`} />
            <Badge variant="outline">Generated {new Date(metadata.generatedAt).toLocaleString()}</Badge>
          </CardContent>
        </Card>

        <Card className="qa-card">
          <CardHeader>
            <CardTitle className="text-base">Validation checklist</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {[
              ["project", "Selected Azure DevOps project is correct"],
              ["selectedOnly", "Deselected findings are excluded"],
              ["reviewed", "I reviewed and approved the final text"],
            ].map(([key, label]) => (
              <label key={key} className="flex items-start gap-3 rounded-lg border border-border p-3 text-sm">
                <Checkbox
                  checked={checks[key as keyof typeof checks]}
                  onCheckedChange={(checked) => setChecks((current) => ({ ...current, [key]: Boolean(checked) }))}
                  aria-label={label}
                />
                <span className="text-muted-foreground">{label}</span>
              </label>
            ))}
          </CardContent>
        </Card>

        <Alert className="border-primary/20 bg-accent">
          <AlertTitle>Push requires confirmation</AlertTitle>
          <AlertDescription className="text-muted-foreground">
            Requirement comments are never pushed until selected findings have been reviewed.
          </AlertDescription>
        </Alert>

        <div className="flex flex-col gap-2">
          <ConfirmationDialog
            trigger={
              <Button disabled={!ready}>
                <Send className="size-4" />
                Push to Azure DevOps
              </Button>
            }
            title="Push requirement review comment?"
            description={
              <div className="space-y-1">
                <p>Project: {projectName}</p>
                <p>Target story: {targetStoryLabel ?? metadata.targetStoryId}</p>
                <p>Selected findings: {metadata.findingsCount}</p>
              </div>
            }
            confirmLabel="Push comment"
            onConfirm={pushComment}
          />
          <Button
            variant="outline"
            onClick={() => {
              void navigator.clipboard?.writeText(comment)
              toast.success("Comment copied")
            }}
          >
            <Clipboard className="size-4" />
            Copy fallback
          </Button>
        </div>
      </div>
    </div>
  )
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs font-medium uppercase tracking-normal text-muted-foreground">{label}</div>
      <div className="mt-1 font-semibold text-foreground">{value}</div>
    </div>
  )
}

