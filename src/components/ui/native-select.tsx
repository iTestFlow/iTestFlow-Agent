import { ChevronDown } from "lucide-react"
import { forwardRef, type ComponentPropsWithoutRef } from "react"

import { cn } from "@/lib/utils"

/**
 * Styled native `<select>` with a consistent chevron affordance. Replaces the
 * `<div className="relative"><select className="… appearance-none …"/><ChevronDown/></div>`
 * block that was hand-copied across the workflow forms, so height, radius, focus
 * ring, disabled state, and the chevron live in one place. All native `<select>`
 * props (value, onChange, disabled, aria-label, children, …) pass straight through.
 */
export const NativeSelect = forwardRef<
  HTMLSelectElement,
  ComponentPropsWithoutRef<"select"> & { containerClassName?: string }
>(function NativeSelect({ className, containerClassName, children, ...props }, ref) {
  return (
    <div className={cn("relative", containerClassName)}>
      <select
        ref={ref}
        {...props}
        className={cn(
          "focus-ring h-8 w-full min-w-0 appearance-none truncate rounded-lg border border-input bg-background pl-2.5 pr-9 text-sm text-foreground transition-colors duration-ui disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
      >
        {children}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden="true"
      />
    </div>
  )
})
