"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/shared/lib/utils";
import { HeaderProjectSelector } from "@/shared/components/live/project-status";

const navigation = [
  { href: "/dashboard", label: "Home" },
  { href: "/context", label: "Project Context" },
  { href: "/requirements/select", label: "Requirement Analysis", section: "/requirements" },
  { href: "/test-cases/select", label: "Test Case Design", section: "/test-cases" },
  { href: "/existing-test-case-review", label: "Existing Test Case Review" },
  { href: "/coverage", label: "Coverage Matrix" },
  { href: "/reports", label: "Reports" },
  { href: "/audit-logs", label: "Audit Logs" },
  { href: "/settings", label: "Settings" },
];

const pageTitles = [
  { match: "/dashboard", title: "Home / Dashboard" },
  { match: "/context", title: "Project Context / RAG" },
  { match: "/requirements/comment", title: "Requirement Analysis - Final Comment Preview" },
  { match: "/requirements/findings", title: "Requirement Analysis - Findings Results List" },
  { match: "/requirements/select", title: "Requirement Analysis - Select Requirement & Context Stories" },
  { match: "/test-cases/edit", title: "Test Case Design - Full Edit Drawer" },
  { match: "/test-cases/new", title: "Test Case Design - Add New Test Case" },
  { match: "/test-cases/publish/result", title: "Publish Result Summary" },
  { match: "/test-cases/publish", title: "Publish Test Cases to Azure Test Plan Suite" },
  { match: "/test-cases/results", title: "Test Case Design - Results List (Inline Editable Titles & Steps)" },
  { match: "/test-cases/select", title: "Test Case Design - Select Requirement & Context Stories" },
  { match: "/publish/summary", title: "Publish Result Summary" },
  { match: "/publish", title: "Publish Test Cases to Azure Test Plan Suite" },
  { match: "/existing-test-case-review/additions", title: "Suggested Additions from Existing Test Case Review" },
  { match: "/existing-test-case-review/coverage", title: "Existing Linked Test Case Coverage Matrix" },
  { match: "/existing-test-case-review", title: "Existing Linked Test Case Review" },
  { match: "/coverage", title: "Coverage Matrix" },
  { match: "/reports", title: "Reports" },
  { match: "/audit-logs", title: "Audit Logs / History" },
  { match: "/settings", title: "Settings" },
];

function getPageTitle(pathname: string) {
  return pageTitles.find((item) => pathname === item.match || pathname.startsWith(`${item.match}/`))?.title ?? "iTestFlow";
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  if (pathname === "/configuration" || pathname.startsWith("/configuration/")) {
    return <main className="min-h-screen bg-background text-foreground">{children}</main>;
  }

  return (
    <div className="min-h-screen bg-background p-5 text-foreground">
      <aside className="fixed bottom-5 left-5 top-5 z-40 flex w-[190px] flex-col rounded-[10px] bg-[#0f172a] text-slate-100">
        <div className="px-6 pb-7 pt-6">
          <div className="text-base font-semibold tracking-wide">iTestFlow</div>
        </div>

        <nav className="flex-1 space-y-2 overflow-y-auto px-3">
          {navigation.map((item) => {
            const active =
              pathname === item.href ||
              pathname.startsWith(`${item.href}/`) ||
              Boolean("section" in item && item.section && pathname.startsWith(item.section));
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "block rounded-[8px] px-5 py-2.5 text-sm tracking-wide text-slate-300 transition hover:bg-white/8 hover:text-white",
                  active && "bg-[#284bc3] text-white",
                )}
              >
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="px-6 pb-5 text-xs text-slate-300">
          Help & Support
        </div>
      </aside>

      <div className="min-w-0 pl-[210px]">
        <header className="sticky top-5 z-30 flex min-h-[61px] items-center justify-between gap-5 rounded-[10px] border border-[#c8d4e4] bg-white px-5">
          <h1 className="min-w-[330px] truncate text-[21px] font-bold tracking-normal text-slate-950">
            {getPageTitle(pathname)}
          </h1>

          <div className="min-w-0 flex-1">
            <HeaderProjectSelector />
          </div>
        </header>

        <main className="w-full max-w-none py-5">{children}</main>
      </div>
    </div>
  );
}
