import { describe, expect, it } from "vitest";

import type { AuthenticatedIdentity } from "@/modules/auth/auth-provider";
import {
  authenticatedIdentityMatchesStoredUser,
  type StoredUserIdentity,
} from "@/modules/auth/user.service";

const identity: AuthenticatedIdentity = {
  azureIdentityId: "azure-user-123",
  displayName: "Taylor Tester",
  emailOrUniqueName: "taylor@example.com",
};

function storedUser(overrides: Partial<StoredUserIdentity> = {}): StoredUserIdentity {
  return {
    id: "user_current",
    azureIdentityId: "azure-user-123",
    emailOrUniqueName: "taylor@example.com",
    ...overrides,
  };
}

describe("authenticatedIdentityMatchesStoredUser", () => {
  it("matches by Azure identity ID even when email casing or value changes", () => {
    expect(
      authenticatedIdentityMatchesStoredUser(
        { ...identity, azureIdentityId: "AZURE-USER-123", emailOrUniqueName: "new-address@example.com" },
        storedUser(),
      ),
    ).toBe(true);
  });

  it("rejects a different Azure identity ID even when the email matches", () => {
    expect(
      authenticatedIdentityMatchesStoredUser(
        { ...identity, azureIdentityId: "azure-user-999" },
        storedUser(),
      ),
    ).toBe(false);
  });

  it("falls back to email for a stored user without an Azure identity ID", () => {
    expect(
      authenticatedIdentityMatchesStoredUser(
        { ...identity, emailOrUniqueName: " TAYLOR@example.com " },
        storedUser({ azureIdentityId: null }),
      ),
    ).toBe(true);
  });

  it("rejects a different email when no Azure identity ID is stored", () => {
    expect(
      authenticatedIdentityMatchesStoredUser(
        { ...identity, emailOrUniqueName: "casey@example.com" },
        storedUser({ azureIdentityId: null }),
      ),
    ).toBe(false);
  });
});
