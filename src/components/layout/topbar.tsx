"use client"

import { Menu } from "lucide-react"
import { useEffect, useState } from "react"

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { HeaderProjectSelector } from "@/shared/components/live/project-status"

type AzureProfile = {
  displayName: string
  uniqueName?: string
  imageUrl?: string
}

function initialsFromName(value?: string) {
  if (!value) return "AD"
  const words = value.trim().split(/\s+/).filter(Boolean)
  return words.slice(0, 2).map((word) => word[0]?.toUpperCase()).join("") || "AD"
}

export function Topbar({ onOpenSidebar }: { onOpenSidebar: () => void }) {
  const [profile, setProfile] = useState<AzureProfile | null>(null)
  const [profileError, setProfileError] = useState(false)

  useEffect(() => {
    fetch("/api/azure-devops/profile", { cache: "no-store" })
      .then(async (response) => {
        const json = await response.json()
        if (!response.ok) throw new Error(json.error ?? "Failed to fetch Azure DevOps profile.")
        setProfile(json.user ?? null)
        setProfileError(false)
      })
      .catch(() => {
        setProfile(null)
        setProfileError(true)
      })
  }, [])

  return (
    <header className="sticky top-0 z-30 flex min-h-16 items-center gap-3 border-b border-[#DCDFE4] bg-white px-4 lg:px-6">
      <Button
        variant="ghost"
        size="icon"
        className="lg:hidden"
        onClick={onOpenSidebar}
        aria-label="Open navigation"
      >
        <Menu className="size-4" />
      </Button>

      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        <HeaderProjectSelector />
      </div>

      <div className="flex shrink-0 items-center gap-2 rounded-md border border-[#DCDFE4] bg-white px-2 py-1.5">
        <Avatar className="size-7">
          {profile?.imageUrl ? <AvatarImage src={profile.imageUrl} alt="" /> : null}
          <AvatarFallback className="bg-[#E9F2FF] text-xs font-semibold text-[#0C66E4]">
            {initialsFromName(profile?.displayName)}
          </AvatarFallback>
        </Avatar>
        <div className="hidden min-w-0 sm:block">
          <div className="max-w-48 truncate text-sm font-medium text-[#172B4D]">
            {profile?.displayName ?? (profileError ? "Azure DevOps user unavailable" : "Loading Azure DevOps user")}
          </div>
          {profile?.uniqueName ? <div className="max-w-48 truncate text-xs text-[#626F86]">{profile.uniqueName}</div> : null}
        </div>
      </div>

    </header>
  )
}
