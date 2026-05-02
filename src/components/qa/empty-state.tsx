import type { LucideIcon } from "lucide-react"
import { Inbox } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"

export function EmptyState({
  title,
  description,
  actionLabel,
  onAction,
  icon: Icon = Inbox,
}: {
  title: string
  description: string
  actionLabel?: string
  onAction?: () => void
  icon?: LucideIcon
}) {
  return (
    <Card className="qa-card">
      <CardContent className="flex flex-col items-center justify-center px-6 py-10 text-center">
        <div className="rounded-lg border border-[#DCDFE4] bg-white p-3 text-[#626F86]">
          <Icon className="size-5" aria-hidden="true" />
        </div>
        <h3 className="mt-4 text-base font-semibold text-[#172B4D]">{title}</h3>
        <p className="mt-2 max-w-md text-sm leading-6 text-[#626F86]">{description}</p>
        {actionLabel ? (
          <Button className="mt-4" size="sm" onClick={onAction}>
            {actionLabel}
          </Button>
        ) : null}
      </CardContent>
    </Card>
  )
}

