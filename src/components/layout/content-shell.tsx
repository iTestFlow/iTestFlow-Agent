import type { ReactNode } from "react"

import { PageHeader } from "@/components/layout/page-header"
import { cn } from "@/lib/utils"

export function ContentShell({
  title,
  description,
  actions,
  maxWidth = "app",
  children,
}: {
  title: string
  description?: string
  actions?: ReactNode
  maxWidth?: "app" | "dashboard"
  children: ReactNode
}) {
  return (
    <div
      className={cn(
        "mx-auto flex w-full flex-col gap-5 p-4 lg:p-6",
        maxWidth === "dashboard" ? "max-w-dashboard" : "max-w-[1600px]",
      )}
    >
      <PageHeader title={title} description={description} actions={actions} />
      {children}
    </div>
  )
}

