"use client"

import { Fragment, useCallback, useEffect, useState } from "react"
import { CheckCircle2, Eye, MinusCircle, ShieldCheck, UserRound, type LucideIcon } from "lucide-react"
import { toast } from "sonner"

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
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
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Callout } from "@/components/qa/callout"
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
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { apiErrorMessage } from "@/shared/lib/api-error-message"
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

type PermissionValue =
  | "allowed"
  | "build"
  | "manage"
  | "notAllowed"
  | "ownOnly"
  | "promote"
  | "protected"
  | "remove"
  | "viewOnly"

type RolePermission = {
  capability: string
  owner: PermissionValue
  admin: PermissionValue
  member: PermissionValue
}

type PermissionGroup = {
  title: string
  permissions: RolePermission[]
}

const ROLE_LABEL: Record<Role, string> = { owner: "Owner", admin: "Admin", member: "Member" }

const ROLE_SUMMARIES: Array<{ role: Role; title: string; description: string }> = [
  {
    role: "owner",
    title: "Owner",
    description: "Full workspace control, including role management and admin changes.",
  },
  {
    role: "admin",
    title: "Admin",
    description: "Can manage workspace settings and ordinary members, but cannot manage owners/admins.",
  },
  {
    role: "member",
    title: "Member",
    description: "Can use testing workflows, dashboards, and view the member roster without changing it.",
  },
]

const ROLE_PERMISSION_GROUPS: PermissionGroup[] = [
  {
    title: "General Access",
    permissions: [
      {
        capability: "Use testing workflows and dashboards",
        owner: "allowed",
        admin: "allowed",
        member: "allowed",
      },
      {
        capability: "View Knowledge Hub and Business Owner Assistant",
        owner: "viewOnly",
        admin: "viewOnly",
        member: "viewOnly",
      },
    ],
  },
  {
    title: "Personal Settings",
    permissions: [
      {
        capability: "Manage own Azure DevOps and LLM credentials",
        owner: "ownOnly",
        admin: "ownOnly",
        member: "ownOnly",
      },
    ],
  },
  {
    title: "Knowledge Management",
    permissions: [
      {
        capability: "Build or save project knowledge",
        owner: "build",
        admin: "build",
        member: "notAllowed",
      },
      {
        capability: "Promote assistant answers to project knowledge",
        owner: "promote",
        admin: "promote",
        member: "notAllowed",
      },
    ],
  },
  {
    title: "Workspace Administration",
    permissions: [
      {
        capability: "Manage workspace settings, sync credential, and sync schedule",
        owner: "manage",
        admin: "manage",
        member: "notAllowed",
      },
      {
        capability: "View workspace member roster",
        owner: "viewOnly",
        admin: "viewOnly",
        member: "viewOnly",
      },
      {
        capability: "Promote members to admin or owner",
        owner: "promote",
        admin: "notAllowed",
        member: "notAllowed",
      },
      {
        capability: "Remove ordinary members",
        owner: "remove",
        admin: "remove",
        member: "notAllowed",
      },
      {
        capability: "Manage admins or owners",
        owner: "manage",
        admin: "notAllowed",
        member: "notAllowed",
      },
    ],
  },
  {
    title: "Safety Rules",
    permissions: [
      {
        capability: "Remove or demote final owner/admin",
        owner: "protected",
        admin: "protected",
        member: "protected",
      },
    ],
  },
]

const PERMISSION_DISPLAY: Record<
  PermissionValue,
  { label: string; icon: LucideIcon; className: string }
> = {
  allowed: {
    label: "Allowed",
    icon: CheckCircle2,
    className: "border-success/30 bg-success/10 text-success",
  },
  build: {
    label: "Build",
    icon: CheckCircle2,
    className: "border-success/30 bg-success/10 text-success",
  },
  manage: {
    label: "Manage",
    icon: CheckCircle2,
    className: "border-success/30 bg-success/10 text-success",
  },
  notAllowed: {
    label: "Not allowed",
    icon: MinusCircle,
    className: "border-transparent bg-transparent font-normal text-muted-foreground/70",
  },
  ownOnly: {
    label: "Own only",
    icon: UserRound,
    className: "border-info/30 bg-info/10 text-info",
  },
  promote: {
    label: "Promote",
    icon: CheckCircle2,
    className: "border-success/30 bg-success/10 text-success",
  },
  protected: {
    label: "Protected",
    icon: ShieldCheck,
    className: "border-warning/40 bg-warning/15 text-warning-foreground dark:text-warning",
  },
  remove: {
    label: "Remove",
    icon: CheckCircle2,
    className: "border-success/30 bg-success/10 text-success",
  },
  viewOnly: {
    label: "View only",
    icon: Eye,
    className: "border-info/30 bg-info/10 text-info",
  },
}

const MEMBER_DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
})

/** Role options an owner may assign. Admins can remove ordinary members, not change roles. */
function assignableRoles(actorRole: Role | null): Role[] {
  return actorRole === "owner" ? ["owner", "admin", "member"] : ["member"]
}

export function MembersSection() {
  const [data, setData] = useState<MembersResponse | null>(null)
  const [accessDenied, setAccessDenied] = useState(false)
  const [loading, setLoading] = useState(true)
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [permissionMatrixValue, setPermissionMatrixValue] = useState("")

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const response = await fetch("/api/workspace/members", { cache: "no-store" })
      if (response.status === 401 || response.status === 403) {
        setAccessDenied(true)
        setData(null)
        return
      }
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string }
        toast.error(apiErrorMessage(body, "Could not load workspace members."))
        return
      }
      setAccessDenied(false)
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

  const members = data?.members ?? []
  const totalCount = members.length
  const ownerCount = members.filter((m) => m.role === "owner").length
  const adminCount = members.filter((m) => m.role === "admin").length
  const memberCount = members.filter((m) => m.role === "member").length
  const onlyOwner = ownerCount === 1
  const soleOwner = onlyOwner ? members.find((m) => m.role === "owner") : null
  const ownerWarning = data && onlyOwner
    ? soleOwner?.userId === data.currentUserId
      ? "You are the only owner in this workspace. Promote another member to owner before demoting or removing yourself."
      : "This workspace has one owner. Promote another member to owner before changing that owner's role."
    : null

  const actorRole = data?.currentUserRole ?? null
  const canManageWorkspaceMembers = actorRole === "owner" || actorRole === "admin"

  function canManage(member: Member): boolean {
    if (actorRole === "owner") return true
    if (actorRole === "admin") return member.role !== "owner" && member.role !== "admin"
    return false
  }

  function isLastOwner(member: Member): boolean {
    return member.role === "owner" && ownerCount <= 1
  }

  function isLastAdmin(member: Member): boolean {
    return member.role === "admin" && adminCount <= 1
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
        toast.error(apiErrorMessage(body, "Could not update role."))
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
        toast.error(apiErrorMessage(body, "Could not remove member."))
        return
      }
      toast.success(`Removed ${member.displayName ?? member.email ?? "member"} from the workspace.`)
      await load()
    } finally {
      setPendingId(null)
    }
  }

  return (
    <TooltipProvider delayDuration={150}>
      <SectionCard
        title="Workspace Members"
        description={
          data && !canManageWorkspaceMembers
            ? "See who can access this workspace. Role changes and removals are limited to owners and admins."
            : "Manage who can access this workspace and assign roles. People join by signing in with their own Azure DevOps PAT."
        }
      >
        {accessDenied ? (
          <Callout tone="warning" title="Workspace roster unavailable">
            Only active workspace members can view this roster.
          </Callout>
        ) : loading && !data ? (
          <p className="text-sm text-muted-foreground">Loading members...</p>
        ) : data ? (
          <div className="space-y-4">
            <MemberSummary
              totalCount={totalCount}
              ownerCount={ownerCount}
              adminCount={adminCount}
              memberCount={memberCount}
            />

            {ownerWarning ? (
              <Callout tone="warning" title="Only owner protection">
                {ownerWarning}
              </Callout>
            ) : null}

            {!canManageWorkspaceMembers ? (
              <Callout tone="info" title="View-only roster">
                You can see workspace members here, but only owners and admins can change roles or remove people.
              </Callout>
            ) : null}

            <MemberRosterTable
              actorRole={actorRole}
              busyMembershipId={pendingId}
              canManage={canManage}
              currentUserId={data.currentUserId}
              isLastAdmin={isLastAdmin}
              isLastOwner={isLastOwner}
              members={members}
              onChangeRole={onChangeRole}
              onRemove={onRemove}
            />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No workspace member data is available.</p>
        )}
      </SectionCard>

      <SectionCard
        title="Role Permissions"
        description="Compare what Owners, Admins, and Members can do in this workspace."
      >
        <RoleSummaryPanels />

        <Accordion
          type="single"
          collapsible
          value={permissionMatrixValue}
          onValueChange={setPermissionMatrixValue}
          className="space-y-2"
        >
          <AccordionItem value="matrix">
            <AccordionTrigger>
              {permissionMatrixValue === "matrix" ? "Hide permission matrix" : "Show permission matrix"}
            </AccordionTrigger>
            <AccordionContent>
              <RolePermissionsTable />
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </SectionCard>
    </TooltipProvider>
  )
}

function MemberSummary({
  totalCount,
  ownerCount,
  adminCount,
  memberCount,
}: {
  totalCount: number
  ownerCount: number
  adminCount: number
  memberCount: number
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-4">
      <SummaryPill label="Total members" value={totalCount} />
      <SummaryPill label="Owners" value={ownerCount} />
      <SummaryPill label="Admins" value={adminCount} />
      <SummaryPill label="Members" value={memberCount} />
    </div>
  )
}

function SummaryPill({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-border bg-muted/30 px-3 py-2">
      <div className="text-xl font-bold leading-none text-foreground tabular-nums">{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{label}</div>
    </div>
  )
}

function MemberRosterTable({
  actorRole,
  busyMembershipId,
  canManage,
  currentUserId,
  isLastAdmin,
  isLastOwner,
  members,
  onChangeRole,
  onRemove,
}: {
  actorRole: Role | null
  busyMembershipId: string | null
  canManage: (member: Member) => boolean
  currentUserId: string
  isLastAdmin: (member: Member) => boolean
  isLastOwner: (member: Member) => boolean
  members: Member[]
  onChangeRole: (member: Member, role: Role) => Promise<void>
  onRemove: (member: Member) => Promise<void>
}) {
  if (!members.length) {
    return (
      <div className="rounded-md border border-dashed border-border bg-muted/30 p-5 text-sm text-muted-foreground">
        No active workspace members were found.
      </div>
    )
  }

  const canTakeActions = actorRole === "owner" || actorRole === "admin"

  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <Table>
        <TableHeader className="bg-muted/40">
          <TableRow>
            <TableHead className="min-w-[260px] px-4">Member</TableHead>
            <TableHead className="min-w-[150px]">Role</TableHead>
            <TableHead className="min-w-[140px]">Last sign-in</TableHead>
            {canTakeActions ? (
              <TableHead className="min-w-[130px] pr-4 text-right">Actions</TableHead>
            ) : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {members.map((member) => {
            const isSelf = member.userId === currentUserId
            const lastOwner = isLastOwner(member)
            const lastAdmin = isLastAdmin(member)
            const busy = busyMembershipId === member.membershipId
            const manageable = canManage(member)
            const canChangeRole = actorRole === "owner" && !lastOwner && !lastAdmin
            const canRemove = manageable && !lastOwner && !lastAdmin
            const protectedMessage = getProtectedMessage({ isSelf, lastAdmin, lastOwner })

            return (
              <TableRow key={member.membershipId}>
                <TableCell className="px-4 py-3">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="font-medium text-foreground">{member.displayName ?? "Unknown"}</span>
                    {isSelf ? (
                      <Badge variant="outline" className="border-border bg-muted/40 text-muted-foreground">
                        You
                      </Badge>
                    ) : null}
                  </div>
                  {member.email ? (
                    <div className="mt-1 text-xs text-muted-foreground">{member.email}</div>
                  ) : null}
                </TableCell>
                <TableCell className="py-3">
                  {canChangeRole ? (
                    <Select
                      value={member.role}
                      disabled={busy}
                      onValueChange={(value) => void onChangeRole(member, value as Role)}
                    >
                      <SelectTrigger className="h-8 w-32">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {assignableRoles(actorRole).map((role) => (
                          <SelectItem key={role} value={role}>
                            {ROLE_LABEL[role]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <RoleBadge role={member.role} />
                  )}
                </TableCell>
                <TableCell className="py-3 text-sm text-muted-foreground">
                  {formatMemberDate(member.lastLoginAt)}
                </TableCell>
                {canTakeActions ? (
                  <TableCell className="py-3 pr-4 text-right">
                    {protectedMessage ? (
                      <ProtectedAction message={protectedMessage} />
                    ) : canRemove ? (
                      <RemoveMemberAction member={member} busy={busy} onRemove={onRemove} />
                    ) : (
                      <span className="text-xs text-muted-foreground">-</span>
                    )}
                  </TableCell>
                ) : null}
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}

function RoleBadge({ role }: { role: Role }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "font-medium",
        role === "owner" && "border-primary/30 bg-primary/10 text-primary",
        role === "admin" && "border-info/30 bg-info/10 text-info",
        role === "member" && "border-border bg-muted/50 text-muted-foreground",
      )}
    >
      {ROLE_LABEL[role]}
    </Badge>
  )
}

function ProtectedAction({ message }: { message: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex" tabIndex={0} aria-label={`Protected: ${message}`}>
          <Button type="button" variant="outline" size="sm" disabled className="gap-1">
            <ShieldCheck className="size-3.5" aria-hidden="true" />
            Protected
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent side="left" sideOffset={8} className="max-w-xs text-left">
        {message}
      </TooltipContent>
    </Tooltip>
  )
}

function RemoveMemberAction({
  member,
  busy,
  onRemove,
}: {
  member: Member
  busy: boolean
  onRemove: (member: Member) => Promise<void>
}) {
  return (
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
  )
}

function RoleSummaryPanels() {
  return (
    <div className="grid gap-3 md:grid-cols-3">
      {ROLE_SUMMARIES.map((summary) => (
        <div key={summary.role} className="rounded-md border border-border bg-muted/30 p-3">
          <div className="flex items-center justify-between gap-2">
          <div className="text-sm font-semibold text-foreground">{summary.title}</div>
          <RoleBadge role={summary.role} />
          </div>
          <div className="mt-2 text-xs leading-5 text-muted-foreground">{summary.description}</div>
        </div>
      ))}
    </div>
  )
}

function RolePermissionsTable() {
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <Table>
        <TableHeader className="bg-muted/40">
          <TableRow>
            <TableHead className="min-w-[280px] px-4">Capability</TableHead>
            <TableHead className="min-w-[130px]">Owner</TableHead>
            <TableHead className="min-w-[130px]">Admin</TableHead>
            <TableHead className="min-w-[130px]">Member</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {ROLE_PERMISSION_GROUPS.map((group) => (
            <Fragment key={group.title}>
              <TableRow className="bg-muted/30 hover:bg-muted/30">
                <TableCell colSpan={4} className="px-4 py-2 text-xs font-semibold uppercase text-muted-foreground">
                  {group.title}
                </TableCell>
              </TableRow>
              {group.permissions.map((permission) => (
                <TableRow key={permission.capability}>
                  <TableCell className="px-4 font-medium">{permission.capability}</TableCell>
                  <PermissionCell value={permission.owner} />
                  <PermissionCell value={permission.admin} />
                  <PermissionCell value={permission.member} />
                </TableRow>
              ))}
            </Fragment>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function PermissionCell({ value }: { value: PermissionValue }) {
  const display = PERMISSION_DISPLAY[value]
  const Icon = display.icon

  return (
    <TableCell>
      <Badge variant="outline" className={cn("font-medium", display.className)}>
        <Icon className="size-3" aria-hidden="true" />
        {display.label}
      </Badge>
    </TableCell>
  )
}

function getProtectedMessage({
  isSelf,
  lastAdmin,
  lastOwner,
}: {
  isSelf: boolean
  lastAdmin: boolean
  lastOwner: boolean
}) {
  if (lastOwner) {
    return isSelf
      ? "You are the only owner. Promote another member to owner before changing this role."
      : "This is the only owner. Promote another member to owner before changing this role."
  }
  if (lastAdmin) {
    return "This is the only admin. Promote another member to admin before changing this role."
  }
  return null
}

function formatMemberDate(value: string | null) {
  if (!value) return "Never"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "Never"
  return MEMBER_DATE_FORMATTER.format(date)
}
