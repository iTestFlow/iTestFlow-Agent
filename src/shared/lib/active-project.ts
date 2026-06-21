export type ActiveProjectScope = {
  projectId: string;
  azureProjectId: string;
  azureProjectName: string;
  azureOrganizationUrl: string;
  /** The workspace this project belongs to; sent with feature requests for server-side validation. */
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
