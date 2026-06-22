"use client"

import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { OwnerOnlyNotice } from "./owner-only-notice"
import { SectionCard } from "./section-card"

type Role = "owner" | "admin" | "member"

type Member = {
  membershipId: string
  userId: string
  role: Role
  status: string
  displayName: string | null
  email: string | null
  lastLoginAt: string | null
  createdAt: string
}

type MembersResponse = {
  workspaceId: string
  currentUserId: string
  currentUserRole: Role | null
  members: Member[]
}

const ROLE_LABEL: Record<Role, string> = { owner: "Owner", admin: "Admin", member: "Member" }

/** Role options an actor may assign — admins can never grant `owner`. */
function assignableRoles(actorRole: Role | null): Role[] {
  return actorRole === "owner" ? ["owner", "admin", "member"] : ["admin", "member"]
}

export function MembersSection() {
  const [data, setData] = useState<MembersResponse | null>(null)
  const [forbidden, setForbidden] = useState(false)
  const [loading, setLoading] = useState(true)
  const [pendingId, setPendingId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const response = await fetch("/api/workspace/members", { cache: "no-store" })
      if (response.status === 401 || response.status === 403) {
        setForbidden(true)
        return
      }
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string }
        toast.error(body.error ?? "Could not load workspace members.")
        return
      }
      setData((await response.json()) as MembersResponse)
    } catch {
      toast.error("Could not load workspace members.")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const actorRole = data?.currentUserRole ?? null
  const ownerCount = data?.members.filter((m) => m.role === "owner").length ?? 0

  function canManage(member: Member): boolean {
    if (!actorRole) return false
    if (actorRole === "owner") return true
    return member.role !== "owner"
  }

  function isLastOwner(member: Member): boolean {
    return member.role === "owner" && ownerCount <= 1
  }

  async function onChangeRole(member: Member, role: Role) {
    if (role === member.role) return
    setPendingId(member.membershipId)
    try {
      const response = await fetch(`/api/workspace/members/${member.membershipId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
      })
      const body = (await response.json().catch(() => ({}))) as { error?: string }
      if (!response.ok) {
        toast.error(body.error ?? "Could not update role.")
        return
      }
      toast.success(`Updated ${member.displayName ?? member.email ?? "member"} to ${ROLE_LABEL[role]}.`)
      await load()
    } finally {
      setPendingId(null)
    }
  }

  async function onRemove(member: Member) {
    setPendingId(member.membershipId)
    try {
      const response = await fetch(`/api/workspace/members/${member.membershipId}`, { method: "DELETE" })
      const body = (await response.json().catch(() => ({}))) as { error?: string }
      if (!response.ok) {
        toast.error(body.error ?? "Could not remove member.")
        return
      }
      toast.success(`Removed ${member.displayName ?? member.email ?? "member"} from the workspace.`)
      await load()
    } finally {
      setPendingId(null)
    }
  }

  return (
    <SectionCard
      title="Workspace Members"
      description="Manage who can access this workspace and their role. People join by signing in with their own Azure DevOps PAT; promote, demote, or remove them here."
    >
      {forbidden ? (
        <OwnerOnlyNotice />
      ) : loading && !data ? (
        <p className="text-sm text-muted-foreground">Loading members…</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Member</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Last sign-in</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data?.members.map((member) => {
              const isSelf = member.userId === data.currentUserId
              const manageable = canManage(member)
              const lastOwner = isLastOwner(member)
              const roleLocked = !manageable || lastOwner
              const options = assignableRoles(actorRole)
              const busy = pendingId === member.membershipId
              return (
                <TableRow key={member.membershipId}>
                  <TableCell>
                    <div className="font-medium">
                      {member.displayName ?? "Unknown"}
                      {isSelf ? <span className="ml-1 text-xs text-muted-foreground">(You)</span> : null}
                    </div>
                    {member.email ? <div className="text-xs text-muted-foreground">{member.email}</div> : null}
                  </TableCell>
                  <TableCell>
                    {roleLocked ? (
                      <Badge variant={member.role === "owner" ? "default" : "secondary"}>{ROLE_LABEL[member.role]}</Badge>
                    ) : (
                      <Select value={member.role} disabled={busy} onValueChange={(value) => void onChangeRole(member, value as Role)}>
                        <SelectTrigger className="h-8 w-32">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {options.map((role) => (
                            <SelectItem key={role} value={role}>
                              {ROLE_LABEL[role]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {member.lastLoginAt ? new Date(member.lastLoginAt).toLocaleDateString() : "Never"}
                  </TableCell>
                  <TableCell className="text-right">
                    {manageable && !lastOwner ? (
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button variant="ghost" size="sm" className="text-destructive" disabled={busy}>
                            Remove
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Remove from workspace?</AlertDialogTitle>
                            <AlertDialogDescription>
                              {member.displayName ?? member.email ?? "This member"} will immediately lose access to this
                              workspace. They can rejoin by signing in again with their Azure DevOps PAT.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction onClick={() => void onRemove(member)}>Remove</AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    ) : (
                      <span className="text-xs text-muted-foreground">{lastOwner ? "Last owner" : "—"}</span>
                    )}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      )}
    </SectionCard>
  )
}
