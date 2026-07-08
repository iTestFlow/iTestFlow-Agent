import type { ProviderAuthenticatedUser, ProviderProject } from "./integration-types";

export interface ProviderConnection {
  testConnection(): Promise<boolean>;

  fetchAuthenticatedUser(): Promise<ProviderAuthenticatedUser>;

  fetchProjects(): Promise<ProviderProject[]>;
}
