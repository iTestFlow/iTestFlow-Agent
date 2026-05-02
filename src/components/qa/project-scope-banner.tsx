"use client"

import { useEffect, useState } from "react"
import { AlertCircle, CheckCircle2 } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { readActiveProject, type ActiveProjectScope } from "@/shared/lib/active-project"

export function ProjectScopeBanner({
  projectName,
  hasProject = true,
}: {
  projectName?: string
  hasProject?: boolean
}) {
  const [activeProject, setActiveProject] = useState<ActiveProjectScope | null>(null)

  useEffect(() => {
    setActiveProject(readActiveProject())
    const onChange = (event: Event) => {
      const custom = event as CustomEvent<ActiveProjectScope>
      setActiveProject(custom.detail ?? readActiveProject())
    }
    window.addEventListener("itestflow:active-project-changed", onChange)
    return () => window.removeEventListener("itestflow:active-project-changed", onChange)
  }, [])

  const resolvedProjectName = projectName ?? activeProject?.azureProjectName
  const resolvedHasProject = hasProject ?? Boolean(resolvedProjectName)

  if (!resolvedHasProject) {
    return (
      <Alert className="border-[#F5CD47]/60 bg-[#FFF7D6] text-[#172B4D]">
        <AlertCircle className="size-4 text-[#7F5F01]" />
        <AlertTitle>No Azure DevOps project selected</AlertTitle>
        <AlertDescription className="flex flex-col gap-3 text-[#44546F] sm:flex-row sm:items-center sm:justify-between">
          Select a project before syncing, analyzing requirements, or publishing test cases.
          <Button size="sm" variant="outline" disabled>
            Actions disabled
          </Button>
        </AlertDescription>
      </Alert>
    )
  }

  return (
    <Alert className="border-[#0C66E4]/20 bg-[#E9F2FF] text-[#172B4D]">
      <CheckCircle2 className="size-4 text-[#0C66E4]" />
      <AlertTitle>Project scope active</AlertTitle>
      <AlertDescription className="text-[#44546F]">
        All content is scoped to selected project: <span className="font-semibold">{resolvedProjectName}</span>.
      </AlertDescription>
    </Alert>
  )
}
