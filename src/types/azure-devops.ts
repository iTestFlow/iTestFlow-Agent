export type AzureDevOpsStatus = "connected" | "required" | "syncing" | "error"

export type Organization = {
  id: string
  name: string
  url: string
}

export type AzureDevOpsProject = {
  id: string
  organizationId: string
  name: string
  process: "Agile" | "Scrum" | "CMMI"
  visibility: "private" | "public"
  lastSyncedAt: string
}

export type WorkItemType = "User Story" | "Bug" | "Feature" | "Task" | "Test Case"
export type WorkItemState = "New" | "Active" | "Resolved" | "Closed" | "Ready for QA"
export type WorkItemPriority = "1 - Critical" | "2 - High" | "3 - Medium" | "4 - Low"

export type ProjectUser = {
  id: string
  displayName: string
  uniqueName?: string
  imageUrl?: string
}

export type WorkItem = {
  id: string
  numericId: number
  projectId: string
  type: WorkItemType
  title: string
  state: WorkItemState
  assignedTo: string
  priority: WorkItemPriority
  area: string
  iteration: string
  updatedAt: string
  tags: string[]
  description: string
  acceptanceCriteria: string[]
  links: Array<{ id: string; title: string; relation: string }>
  testedByCount: number
  testsCount: number
}

export type ContextSuggestion = {
  id: string
  projectId: string
  workItemId: string
  title: string
  type: WorkItemType
  relationship: "Parent" | "Sibling" | "Dependency" | "Related" | "Historical"
  relevance: number
  reason: string
}

export type ContextDocument = {
  id: string
  projectId: string
  name: string
  type: "Markdown" | "PDF" | "Confluence Export" | "Decision Record"
  chunks: number
  indexedAt: string
  status: "Indexed" | "Queued" | "Needs re-index"
}

export type IndexedChunk = {
  id: string
  projectId: string
  source: string
  heading: string
  tokens: number
  score: number
  preview: string
}

