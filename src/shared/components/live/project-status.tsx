"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useUnsavedChangesGuard } from "@/components/navigation/unsaved-changes-provider";
import { apiErrorMessage, caughtErrorMessage } from "@/shared/lib/api-error-message";
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
    if (!response.ok) throw new Error(apiErrorMessage(json, "Failed to select Azure DevOps project."));
    return json.scope as ActiveProjectScope;
  }

  useEffect(() => {
    setActiveProject(readActiveProject());
    fetch("/api/azure-devops/projects", { cache: "no-store" })
      .then(async (response) => {
        const json = await response.json();
        if (!response.ok) throw new Error(apiErrorMessage(json, "Failed to fetch Azure DevOps projects."));
        return json as { projects?: AzureProject[]; workspaceId?: string };
      })
      .then(async (json) => {
        // Listing projects is proof Azure DevOps is actually connected: clear any
        // earlier "not configured" state and show the real project list, even if
        // the background re-select step below runs into trouble.
        const loadedProjects = (json.projects ?? []) as AzureProject[];
        setProjects(loadedProjects);
        setError(null);
        const stored = readActiveProject();
        const projectToRefresh = projectSelectionNeedingRefresh(stored, loadedProjects, json.workspaceId);
        if (!projectToRefresh) return;
        try {
          const scope = await selectProject(projectToRefresh);
          writeActiveProject(scope);
          setActiveProject(scope);
        } catch (err) {
          // A failed automatic re-select (e.g. a transient error, or the
          // previously active project no longer resolving) is not a connection
          // problem: Azure DevOps is connected, we just couldn't refresh which
          // project is active. Don't misreport the connection as unconfigured.
          toast.error(caughtErrorMessage(err, "Could not refresh the active Azure DevOps project."));
        }
      })
      .catch((err: unknown) => setError(caughtErrorMessage(err, "Azure DevOps is not configured.")));

    const onChange = (event: Event) => {
      const custom = event as CustomEvent<ActiveProjectScope>;
      setActiveProject(custom.detail ?? readActiveProject());
    };
    window.addEventListener("itestflow:active-project-changed", onChange);
    return () => window.removeEventListener("itestflow:active-project-changed", onChange);
  }, []);

  if (error) {
    return (
      <div className="flex w-full min-w-0 items-center gap-2 sm:gap-5">
        <div className="hidden h-8 w-[260px] shrink-0 items-center rounded-lg border border-border bg-background px-3 text-sm text-foreground 2xl:flex">
          Org: Not configured
        </div>
        <div className="flex h-8 min-w-0 max-w-[330px] flex-1 items-center truncate rounded-lg border border-warning/40 bg-warning/15 px-3 text-sm text-warning-foreground dark:text-warning">
          Azure DevOps not configured
        </div>
      </div>
    );
  }

  return (
    <div className="flex w-full min-w-0 items-center gap-2 sm:gap-5">
      <div className="hidden h-8 w-[260px] shrink-0 items-center truncate rounded-lg border border-border bg-background px-3 text-sm text-foreground 2xl:flex">
        {organizationLabel(activeProject?.azureOrganizationUrl ?? projects[0]?.azureOrganizationUrl)}
      </div>
      <select
        className="focus-ring h-8 min-w-0 max-w-[330px] flex-1 rounded-lg border border-border bg-background px-3 text-sm text-foreground"
        value={activeProject?.azureProjectId ?? ""}
        onChange={(event) => {
          const project = projects.find((item) => item.id === event.target.value);
          if (!project) return;
          confirmAction(() => {
            void selectProject(project).then((scope) => {
              writeActiveProject(scope);
              setActiveProject(scope);
            }).catch((err: unknown) => {
              // A failed manual re-select is not a connection problem either: keep
              // showing the loaded project list and surface this as a one-off
              // notification instead of collapsing to "not configured".
              toast.error(caughtErrorMessage(err, "Azure DevOps project selection failed."));
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
