import "server-only";

import type { AuthenticatedIdentity, AuthProvider } from "./auth-provider";

/**
 * Stub provider (ADR-8 / ADR-10). Real Azure DevOps PAT validation — verify the
 * PAT, read the Azure identity/profile, confirm org membership — is implemented
 * in Phase 2 alongside encrypted credential storage. Until then this throws so
 * no half-built auth path is silently relied upon.
 */
export class PatAuthProvider implements AuthProvider {
  readonly id = "azure-pat";

  authenticate(): Promise<AuthenticatedIdentity> {
    throw new Error("PAT authentication is implemented in Phase 2.");
  }
}
