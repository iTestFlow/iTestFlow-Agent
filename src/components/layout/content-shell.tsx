import type { ReactNode } from "react"

import { PageHeader } from "@/components/layout/page-header"
import { ProjectScopeBanner } from "@/components/qa/project-scope-banner"

export function ContentShell({
  title,
  description,
  actions,
  children,
  showProjectScope = true,
}: {
  title: string
  description?: string
  actions?: ReactNode
  children: ReactNode
  showProjectScope?: boolean
}) {
  return (
    <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-4 p-4 lg:p-6">
      <PageHeader title={title} description={description} actions={actions} />
      {showProjectScope ? <ProjectScopeBanner /> : null}
      {children}
    </div>
  )
}

