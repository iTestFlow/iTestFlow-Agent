"use client"

import { Check, Monitor, Moon, Sun } from "lucide-react"
import { useTheme } from "next-themes"
import { useEffect, useState } from "react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

const options = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
] as const

export function ThemeToggle() {
  const [mounted, setMounted] = useState(false)
  const { theme, resolvedTheme, setTheme } = useTheme()

  useEffect(() => setMounted(true), [])

  const activeTheme = mounted ? theme ?? "system" : "system"
  const ActiveIcon = mounted && resolvedTheme === "dark" ? Moon : Sun

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="icon"
              className="border-border/80 bg-card/80 text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label="Change theme"
            >
              <ActiveIcon className="size-4" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent sideOffset={8}>Theme</TooltipContent>
      </Tooltip>

      <DropdownMenuContent align="end" className="w-40">
        {options.map((option) => {
          const Icon = option.icon
          const selected = activeTheme === option.value

          return (
            <DropdownMenuItem
              key={option.value}
              onClick={() => setTheme(option.value)}
              className="justify-between"
            >
              <span className="flex items-center gap-2">
                <Icon className="size-4" aria-hidden="true" />
                {option.label}
              </span>
              <Check
                className={cn("size-4 opacity-0", selected && "opacity-100")}
                aria-hidden="true"
              />
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
