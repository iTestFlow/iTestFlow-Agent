"use client"

import Link from "next/link"
import { Loader2 } from "lucide-react"
import { forwardRef, type ComponentPropsWithoutRef } from "react"

import { useNavigationFeedback } from "@/components/navigation/unsaved-changes-provider"
import { cn } from "@/lib/utils"

type NavigationLinkProps = ComponentPropsWithoutRef<typeof Link>

export const NavigationLink = forwardRef<HTMLAnchorElement, NavigationLinkProps>(
  function NavigationLink({ children, className, href, ...props }, ref) {
    const { navigationPending, pendingHref } = useNavigationFeedback()
    const hrefValue = typeof href === "string" ? href : href.pathname ?? ""
    const isPendingDestination = navigationPending && pendingHref === hrefValue

    return (
      <Link
        {...props}
        ref={ref}
        href={href}
        aria-disabled={navigationPending || props["aria-disabled"] || undefined}
        aria-busy={isPendingDestination || props["aria-busy"] || undefined}
        className={cn(className, navigationPending && "cursor-not-allowed opacity-60")}
      >
        {children}
        {isPendingDestination ? (
          <Loader2
            className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
        ) : null}
      </Link>
    )
  },
)
