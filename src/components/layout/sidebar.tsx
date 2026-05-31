"use client"

import Image from "next/image"
import Link from "next/link"
import { usePathname } from "next/navigation"
import {
  ClipboardCheck,
  FileText,
  HelpCircle,
  Home,
  ListPlus,
  MessageSquareText,
  Replace,
  Settings,
  ShieldCheck,
  TestTube2,
} from "lucide-react"

import { Separator } from "@/components/ui/separator"
import { BRAND_ICON_SRC, PRODUCT_NAME } from "@/lib/constants"
import { cn } from "@/lib/utils"

const navigation = [
  { href: "/dashboard", label: "Home", icon: Home },
  { href: "/context", label: "Project Context", icon: FileText },
  { href: "/context-chatbot", label: "Context Chatbot", icon: MessageSquareText },
  { href: "/requirements/analyze", label: "Requirement Analysis", icon: ShieldCheck, section: "/requirements" },
  { href: "/test-cases/design/context", label: "Test Case Design", icon: TestTube2, section: "/test-cases/design" },
  { href: "/test-coverage-matrix", label: "Test Coverage Matrix", icon: ClipboardCheck },
  { href: "/test-suite-migration", label: "Suite Migration", icon: Replace },
  { href: "/bulk-tasks", label: "Bulk Task Creation", icon: ListPlus },
  { href: "/settings", label: "Settings", icon: Settings },
]

export function Sidebar({ className, onNavigate }: { className?: string; onNavigate?: () => void }) {
  const pathname = usePathname()

  return (
    <aside className={cn("flex h-full flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground", className)}>
      <div className="px-4 py-5">
        <Link href="/dashboard" onClick={onNavigate} className="flex items-center gap-3">
          <div className="flex h-10 w-12 shrink-0 items-center justify-center rounded-lg bg-white p-1.5 shadow-sm ring-1 ring-sidebar-border">
            <Image
              src={BRAND_ICON_SRC}
              alt=""
              width={510}
              height={342}
              priority
              className="h-full w-full object-contain"
            />
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{PRODUCT_NAME}</div>
            <div className="text-[11px] leading-4 text-sidebar-foreground/60">AI-Powered Software Testing Lifecycle</div>
          </div>
        </Link>
      </div>

      <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3">
        {navigation.map((item) => {
          const Icon = item.icon
          const active =
            pathname === item.href ||
            pathname.startsWith(`${item.href}/`) ||
            Boolean(item.section && pathname.startsWith(item.section))

          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavigate}
              className={cn(
                "flex min-h-9 items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-sidebar-foreground/70 transition hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                active && "bg-sidebar-accent text-sidebar-accent-foreground shadow-sm ring-1 ring-sidebar-ring/20 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              )}
            >
              <Icon className="size-4 shrink-0" aria-hidden="true" />
              <span className="truncate">{item.label}</span>
            </Link>
          )
        })}
      </nav>

      <div className="px-3 pb-4">
        <Separator className="mb-3 bg-sidebar-border" />
        <Link
          href="/settings"
          onClick={onNavigate}
          className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-sidebar-foreground/70 transition hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        >
          <HelpCircle className="size-4" aria-hidden="true" />
          Help & Support
        </Link>
      </div>
    </aside>
  )
}
