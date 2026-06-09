"use client"

import Image from "next/image"
import Link from "next/link"
import { usePathname } from "next/navigation"
import {
  ArrowRightLeft,
  Bot,
  Bug,
  ClipboardList,
  History,
  LayoutDashboard,
  Library,
  ListPlus,
  Radar,
  Settings,
  ShieldCheck,
  Timer,
  type LucideIcon,
} from "lucide-react"

import { BRAND_ICON_SRC, PRODUCT_NAME } from "@/lib/constants"
import { cn } from "@/lib/utils"

type NavLeaf = { label: string; href: string; icon: LucideIcon }
type NavNode =
  | { type: "item"; item: NavLeaf }
  | { type: "group"; label: string; items: NavLeaf[] }

const navigation: NavNode[] = [
  { type: "item", item: { label: "Dashboards", href: "/dashboards", icon: LayoutDashboard } },
  {
    type: "group",
    label: "Knowledge & Context",
    items: [
      { label: "Knowledge Hub", href: "/knowledge-hub", icon: Library },
      { label: "Business Owner Assistant", href: "/business-owner-assistant", icon: Bot },
    ],
  },
  {
    type: "group",
    label: "Testing Lifecycle",
    items: [
      { label: "Requirements Analysis", href: "/requirements-analysis", icon: ShieldCheck },
      { label: "Test Case Design", href: "/test-case-design", icon: ClipboardList },
      { label: "Test Gap Analysis", href: "/test-gap-analysis", icon: Radar },
      { label: "Report Bug", href: "/report-bug", icon: Bug },
      { label: "Test Execution Effort", href: "/test-execution-effort", icon: Timer },
    ],
  },
  {
    type: "group",
    label: "Utilities",
    items: [
      { label: "Suite Migration", href: "/suite-migration", icon: ArrowRightLeft },
      { label: "Bulk Task Creation", href: "/bulk-task-creation", icon: ListPlus },
    ],
  },
  {
    type: "group",
    label: "Administration",
    items: [
      { label: "Settings", href: "/settings", icon: Settings },
      { label: "Activity Log", href: "/activity-log", icon: History },
    ],
  },
]

function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`)
}

function NavLink({ item, onNavigate, active }: { item: NavLeaf; onNavigate?: () => void; active: boolean }) {
  const Icon = item.icon
  return (
    <Link
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
}

export function Sidebar({ className, onNavigate }: { className?: string; onNavigate?: () => void }) {
  const pathname = usePathname()

  return (
    <aside className={cn("flex h-full flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground", className)}>
      <div className="px-4 py-5">
        <Link href="/dashboards" onClick={onNavigate} className="flex items-center gap-3">
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

      <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 pb-2">
        {navigation.map((node, index) => {
          if (node.type === "item") {
            return (
              <NavLink
                key={node.item.href}
                item={node.item}
                onNavigate={onNavigate}
                active={isActive(pathname, node.item.href)}
              />
            )
          }

          return (
            <div key={node.label} className={cn("space-y-1", index > 0 && "pt-4")}>
              <p className="px-3 pb-1 text-xs font-medium tracking-normal text-sidebar-foreground/50">
                {node.label}
              </p>
              {node.items.map((item) => (
                <NavLink
                  key={item.href}
                  item={item}
                  onNavigate={onNavigate}
                  active={isActive(pathname, item.href)}
                />
              ))}
            </div>
          )
        })}
      </nav>
    </aside>
  )
}
