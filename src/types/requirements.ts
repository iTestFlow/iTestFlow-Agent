export type FindingSeverity = "Critical" | "High" | "Medium" | "Low"

export type RequirementFinding = {
  id: string
  projectId: string
  runId: string
  selected: boolean
  severity: FindingSeverity
  category:
    | "Ambiguity"
    | "Missing acceptance criteria"
    | "Security"
    | "Edge case"
    | "Testability"
    | "Data dependency"
  finding: string
  suggestion: string
  impactScore: number
  sourceReference: string
}

export type RequirementAnalysisRun = {
  id: string
  projectId: string
  targetStoryId: string
  title: string
  score: number
  selectedFindings: number
  status: "Draft" | "Ready" | "Pushed"
  createdAt: string
}

export type FinalCommentMetadata = {
  projectId: string
  targetStoryId: string
  generatedAt: string
  findingsCount: number
  contextStoriesCount: number
  author: string
}

