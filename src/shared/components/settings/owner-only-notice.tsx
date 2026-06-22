"use client"

/** Shown in an owner/admin-only section when the current user is just a member. */
export function OwnerOnlyNotice({ children }: { children?: React.ReactNode }) {
  return (
    <div className="rounded-md border border-dashed border-border bg-muted/30 p-4 text-sm text-muted-foreground">
      {children ?? "Only workspace owners and admins can change these settings."}
    </div>
  )
}
