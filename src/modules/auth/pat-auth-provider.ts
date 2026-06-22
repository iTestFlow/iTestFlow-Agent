import "server-only";

import { AzureDevOpsRestAdapter } from "@/modules/integrations/azure-devops/azure-devops-client";
import type { AuthenticatedIdentity, AuthProvider } from "./auth-provider";

/**
 * Validates an Azure DevOps Personal Access Token against the given organization
 * and reads the caller's Azure identity (ADR-10 concrete provider). The PAT is
 * used only to read the authenticated profile here; storing it encrypted for the
 * user/workspace is the caller's responsibility (login route).
 */
export class PatAuthProvider implements AuthProvider {
  readonly id = "azure-pat";

  async authenticate(input: Record<string, unknown>): Promise<AuthenticatedIdentity> {
    const organizationUrl = typeof input.organizationUrl === "string" ? input.organizationUrl.trim() : "";
    const pat = typeof input.personalAccessToken === "string" ? input.personalAccessToken.trim() : "";
    if (!organizationUrl) throw new Error("Azure DevOps organization URL is required.");
    if (!pat) throw new Error("Azure DevOps Personal Access Token is required.");

    const adapter = new AzureDevOpsRestAdapter({ organizationUrl, personalAccessToken: pat });
    let user: Awaited<ReturnType<AzureDevOpsRestAdapter["fetchAuthenticatedUser"]>>;
    try {
      user = await adapter.fetchAuthenticatedUser();
    } catch {
      throw new Error("Azure DevOps rejected the Personal Access Token, or the organization URL is incorrect.");
    }
    if (!user?.id) {
      throw new Error("Azure DevOps did not return an identity for this token.");
    }

    return {
      azureIdentityId: user.id,
      displayName: user.displayName,
      // Prefer a real email so bootstrap-by-email reconciliation works (a seeded
      // owner is keyed by email). Falls back to uniqueName/id only when Azure
      // exposes no email — e.g. older *.visualstudio.com orgs whose uniqueName is
      // a GUID and whose PAT scope omits the identity email.
      emailOrUniqueName: user.emailAddress ?? user.uniqueName ?? user.id,
    };
  }
}
