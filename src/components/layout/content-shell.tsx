import type { ReactNode } from "react"

import { PageHeader } from "@/components/layout/page-header"

export function ContentShell({
  title,
  description,
  actions,
  children,
}: {
  title: string
  description?: string
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-4 p-4 lg:p-6">
      <PageHeader title={title} description={description} actions={actions} />
      {children}
    </div>
  )
}

