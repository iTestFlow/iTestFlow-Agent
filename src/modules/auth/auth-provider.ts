import "server-only";

/**
 * Authentication provider seam (ADR-10). Authentication is decoupled from a
 * specific identity source so a future Entra ID / OAuth SSO provider can be
 * added without reworking the users table (which keys on azure_identity_id /
 * descriptor, not on any particular credential).
 *
 * Phase 2 implements the first concrete provider — PAT validation against Azure
 * DevOps — together with encrypted per-user credential storage.
 */

export type AuthenticatedIdentity = {
  azureIdentityId: string;
  displayName: string;
  emailOrUniqueName: string;
  descriptor?: string;
};

export interface AuthProvider {
  readonly id: string;
  authenticate(input: Record<string, unknown>): Promise<AuthenticatedIdentity>;
}
