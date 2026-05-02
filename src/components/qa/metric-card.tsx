import type { LucideIcon } from "lucide-react"

import { Card, CardContent } from "@/components/ui/card"
import { cn } from "@/lib/utils"

const toneClasses = {
  blue: "border-[#0C66E4]/25 bg-[#E9F2FF] text-[#0052CC]",
  green: "border-[#22A06B]/25 bg-[#E9F8F1] text-[#216E4E]",
  yellow: "border-[#F5CD47]/50 bg-[#FFF7D6] text-[#7F5F01]",
  red: "border-[#E34935]/25 bg-[#FFECEB] text-[#AE2E24]",
  purple: "border-[#6554C0]/25 bg-[#F3F0FF] text-[#6554C0]",
  neutral: "border-[#DCDFE4] bg-white text-[#44546F]",
}

export function MetricCard({
  title,
  value,
  description,
  icon: Icon,
  tone = "blue",
}: {
  title: string
  value: string
  description: string
  icon: LucideIcon
  tone?: keyof typeof toneClasses
}) {
  return (
    <Card className="qa-card">
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-normal text-[#626F86]">{title}</p>
            <div className="mt-2 truncate text-2xl font-bold text-[#172B4D]">{value}</div>
            <p className="mt-1 text-xs leading-5 text-[#626F86]">{description}</p>
          </div>
          <div className={cn("rounded-lg border p-2", toneClasses[tone])}>
            <Icon className="size-4" aria-hidden="true" />
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

