export const DEFAULT_CONTEXT_WORK_ITEM_TYPES = [
  "Epic",
  "Feature",
  "User Story",
  "Product Backlog Item",
  "Requirement",
]

export const CONTEXT_WORK_ITEM_TYPE_OPTIONS = [
  ...DEFAULT_CONTEXT_WORK_ITEM_TYPES,
  "Bug",
  "Issue",
  "Task",
]

export const DEFAULT_CONTEXT_STATES = [
  "New",
  "Active",
  "Approved",
  "Committed",
  "Ready",
  "In Progress",
  "Resolved",
  "Done",
  "Closed",
]

export const CONTEXT_STATE_OPTIONS = [
  ...DEFAULT_CONTEXT_STATES,
  "Removed",
]
