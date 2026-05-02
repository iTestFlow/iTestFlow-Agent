export type CoverageStatus =
  | "Covered"
  | "Partially covered"
  | "Not covered"
  | "Not applicable"
  | "Needs review"

export type AcceptanceCriterion = {
  id: string
  projectId: string
  storyId: string
  text: string
  priority: "P0" | "P1" | "P2" | "P3"
}

export type CoverageCell = {
  testCaseId: string
  status: CoverageStatus
  note: string
}

export type CoverageMatrixRow = {
  criterion: AcceptanceCriterion
  cells: CoverageCell[]
  gap: string
}

