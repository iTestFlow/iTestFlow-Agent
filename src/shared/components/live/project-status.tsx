"use client";

import { useEffect, useState } from "react";
import { readActiveProject, writeActiveProject, type ActiveProjectScope } from "@/shared/lib/active-project";

type AzureProject = {
  id: string;
  name: string;
  azureOrganizationUrl: string;
};

function organizationLabel(value?: string) {
  if (!value) return "Org: Not configured";
  const trimmed = value.replace(/\/$/, "");
  const org = trimmed.split("/").filter(Boolean).pop() ?? trimmed;
  return `Org: ${org}`;
}

export function HeaderProjectSelector() {
  const [projects, setProjects] = useState<AzureProject[]>([]);
  const [activeProject, setActiveProject] = useState<ActiveProjectScope | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setActiveProject(readActiveProject());
    fetch("/api/azure-devops/projects", { cache: "no-store" })
      .then(async (response) => {
        const json = await response.json();
        if (!response.ok) throw new Error(json.error ?? "Failed to fetch Azure DevOps projects.");
        setProjects(json.projects ?? []);
        const stored = readActiveProject();
        if (!stored && json.projects?.[0]) {
          const first = json.projects[0] as AzureProject;
          const scope = {
            projectId: first.id,
            azureProjectId: first.id,
            azureProjectName: first.name,
            azureOrganizationUrl: first.azureOrganizationUrl,
          };
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
      <div className="flex min-w-0 items-center justify-end gap-5">
        <div className="hidden h-8 w-[260px] shrink-0 items-center rounded-lg border border-border bg-background px-3 text-sm text-foreground 2xl:flex">
          Org: Not configured
        </div>
        <div className="flex h-8 w-[330px] items-center rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 text-sm text-amber-700 dark:text-amber-200">
          Azure DevOps not configured
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 items-center justify-end gap-5">
      <div className="hidden h-8 w-[260px] shrink-0 items-center truncate rounded-lg border border-border bg-background px-3 text-sm text-foreground 2xl:flex">
        {organizationLabel(activeProject?.azureOrganizationUrl ?? projects[0]?.azureOrganizationUrl)}
      </div>
      <select
        className="focus-ring h-8 w-[280px] shrink-0 rounded-lg border border-border bg-background px-3 text-sm text-foreground xl:w-[330px]"
        value={activeProject?.azureProjectId ?? ""}
        onChange={(event) => {
          const project = projects.find((item) => item.id === event.target.value);
          if (!project) return;
          const scope = {
            projectId: project.id,
            azureProjectId: project.id,
            azureProjectName: project.name,
            azureOrganizationUrl: project.azureOrganizationUrl,
          };
          writeActiveProject(scope);
          setActiveProject(scope);
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
