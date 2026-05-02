export type AuditStatus = "Success" | "Warning" | "Failed" | "Draft"

export type AuditLog = {
  id: string
  projectId: string
  timestamp: string
  action: string
  entity: string
  status: AuditStatus
  user: string
  details: string
  runId: string
  payloadSummary: string
  errorDetails?: string
}

