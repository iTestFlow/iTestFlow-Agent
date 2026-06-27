export type ActiveProjectScope = {
  projectId: string;
  azureProjectId: string;
  azureProjectName: string;
  azureOrganizationUrl: string;
  /** The workspace this project belongs to; sent with feature requests for server-side validation. */
  workspaceId?: string;
};

export type ActiveProjectOption = {
  id: string;
  name: string;
  azureOrganizationUrl: string;
  workspaceId?: string;
};

export const activeProjectStorageKey = "itestflow.activeProject";

export function readActiveProject(): ActiveProjectScope | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(activeProjectStorageKey);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ActiveProjectScope;
  } catch {
    return null;
  }
}

export function writeActiveProject(scope: ActiveProjectScope) {
  window.localStorage.setItem(activeProjectStorageKey, JSON.stringify(scope));
  window.dispatchEvent(new CustomEvent("itestflow:active-project-changed", { detail: scope }));
}

export function projectOptionWithWorkspace(
  project: ActiveProjectOption,
  fallbackWorkspaceId?: string,
): ActiveProjectOption {
  return {
    ...project,
    workspaceId: project.workspaceId ?? fallbackWorkspaceId,
  };
}

export function projectMatchesActiveScope(
  scope: ActiveProjectScope,
  project: ActiveProjectOption,
  fallbackWorkspaceId?: string,
) {
  const resolvedProject = projectOptionWithWorkspace(project, fallbackWorkspaceId);
  return (
    scope.projectId === resolvedProject.id &&
    scope.azureProjectId === resolvedProject.id &&
    scope.azureProjectName === resolvedProject.name &&
    scope.azureOrganizationUrl === resolvedProject.azureOrganizationUrl &&
    scope.workspaceId === resolvedProject.workspaceId
  );
}

export function projectSelectionNeedingRefresh(
  scope: ActiveProjectScope | null,
  projects: ActiveProjectOption[],
  fallbackWorkspaceId?: string,
): ActiveProjectOption | null {
  if (!projects.length) return null;
  if (!scope) return projectOptionWithWorkspace(projects[0], fallbackWorkspaceId);

  const matchingProject = projects.find((project) => (
    project.id === scope.azureProjectId || project.id === scope.projectId
  ));
  if (!matchingProject) return projectOptionWithWorkspace(projects[0], fallbackWorkspaceId);

  return projectMatchesActiveScope(scope, matchingProject, fallbackWorkspaceId)
    ? null
    : projectOptionWithWorkspace(matchingProject, fallbackWorkspaceId);
}
