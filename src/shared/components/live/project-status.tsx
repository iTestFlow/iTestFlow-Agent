"use client";

import { useEffect, useState } from "react";
import { useUnsavedChangesGuard } from "@/components/navigation/unsaved-changes-provider";
import {
  projectSelectionNeedingRefresh,
  readActiveProject,
  writeActiveProject,
  type ActiveProjectScope,
} from "@/shared/lib/active-project";

type AzureProject = {
  id: string;
  name: string;
  azureOrganizationUrl: string;
  workspaceId?: string;
};

function organizationLabel(value?: string) {
  if (!value) return "Org: Not configured";
  const trimmed = value.replace(/\/$/, "");
  const org = trimmed.split("/").filter(Boolean).pop() ?? trimmed;
  return `Org: ${org}`;
}

export function HeaderProjectSelector() {
  const { confirmAction } = useUnsavedChangesGuard({ dirty: false });
  const [projects, setProjects] = useState<AzureProject[]>([]);
  const [activeProject, setActiveProject] = useState<ActiveProjectScope | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function selectProject(project: AzureProject): Promise<ActiveProjectScope> {
    const response = await fetch("/api/azure-devops/project/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: project.workspaceId, azureProjectId: project.id }),
    });
    const json = await response.json();
    if (!response.ok) throw new Error(json.error ?? "Failed to select Azure DevOps project.");
    return json.scope as ActiveProjectScope;
  }

  useEffect(() => {
    setActiveProject(readActiveProject());
    fetch("/api/azure-devops/projects", { cache: "no-store" })
      .then(async (response) => {
        const json = await response.json();
        if (!response.ok) throw new Error(json.error ?? "Failed to fetch Azure DevOps projects.");
        const loadedProjects = (json.projects ?? []) as AzureProject[];
        setProjects(loadedProjects);
        const stored = readActiveProject();
        const projectToRefresh = projectSelectionNeedingRefresh(stored, loadedProjects, json.workspaceId);
        if (projectToRefresh) {
          const scope = await selectProject(projectToRefresh);
          writeActiveProject(scope);
          setActiveProject(scope);
        }
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Azure DevOps is not configured."));

    const onChange = (event: Event) => {
      const custom = event as CustomEvent<ActiveProjectScope>;
      setActiveProject(custom.detail ?? readActiveProject());
    };
    window.addEventListener("itestflow:active-project-changed", onChange);
    return () => window.removeEventListener("itestflow:active-project-changed", onChange);
  }, []);

  if (error) {
    return (
      <div className="flex min-w-0 items-center gap-2 sm:gap-5">
        <div className="hidden h-8 w-[260px] shrink-0 items-center rounded-lg border border-border bg-background px-3 text-sm text-foreground 2xl:flex">
          Org: Not configured
        </div>
        <div className="flex h-8 w-[min(330px,calc(100vw-8rem))] min-w-0 items-center truncate rounded-lg border border-warning/40 bg-warning/15 px-3 text-sm text-warning-foreground dark:text-warning">
          Azure DevOps not configured
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 items-center gap-2 sm:gap-5">
      <div className="hidden h-8 w-[260px] shrink-0 items-center truncate rounded-lg border border-border bg-background px-3 text-sm text-foreground 2xl:flex">
        {organizationLabel(activeProject?.azureOrganizationUrl ?? projects[0]?.azureOrganizationUrl)}
      </div>
      <select
        className="focus-ring h-8 w-[min(330px,calc(100vw-8rem))] min-w-[120px] rounded-lg border border-border bg-background px-3 text-sm text-foreground"
        value={activeProject?.azureProjectId ?? ""}
        onChange={(event) => {
          const project = projects.find((item) => item.id === event.target.value);
          if (!project) return;
          confirmAction(() => {
            void selectProject(project).then((scope) => {
              writeActiveProject(scope);
              setActiveProject(scope);
            }).catch((err: unknown) => {
              setError(err instanceof Error ? err.message : "Azure DevOps project selection failed.");
            });
          });
        }}
      >
        {projects.length === 0 ? <option value="">Project: No projects loaded</option> : null}
        {projects.map((project) => (
          <option key={project.id} value={project.id}>
            Project: {project.name}
          </option>
        ))}
      </select>
    </div>
  );
}
