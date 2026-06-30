import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchAuthenticatedUser = vi.hoisted(() => vi.fn());
const adapterConstructor = vi.hoisted(() => vi.fn());

vi.mock("@/modules/integrations/azure-devops/azure-devops-client", () => ({
  AzureDevOpsRestAdapter: class {
    constructor(config: unknown) {
      adapterConstructor(config);
    }
    fetchAuthenticatedUser = fetchAuthenticatedUser;
  },
}));

import { PatAuthProvider } from "./pat-auth-provider";

describe("PAT authentication provider", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requires organization and token before constructing an adapter", async () => {
    const provider = new PatAuthProvider();
    await expect(provider.authenticate({ personalAccessToken: "x" })).rejects.toThrow("organization URL");
    await expect(provider.authenticate({ organizationUrl: "https://dev.azure.com/demo" })).rejects.toThrow(
      "Personal Access Token",
    );
    expect(adapterConstructor).not.toHaveBeenCalled();
  });

  it("trims credentials and prefers the returned email identity", async () => {
    fetchAuthenticatedUser.mockResolvedValue({
      id: "azure-user",
      displayName: "QA Owner",
      uniqueName: "unique",
      emailAddress: "qa@example.com",
    });
    const provider = new PatAuthProvider();
    await expect(provider.authenticate({
      organizationUrl: " https://dev.azure.com/demo ",
      personalAccessToken: " pat ",
    })).resolves.toEqual({
      azureIdentityId: "azure-user",
      displayName: "QA Owner",
      emailOrUniqueName: "qa@example.com",
    });
    expect(adapterConstructor).toHaveBeenCalledWith({
      organizationUrl: "https://dev.azure.com/demo",
      personalAccessToken: "pat",
    });
  });

  it("falls back to uniqueName when Azure exposes no email", async () => {
    fetchAuthenticatedUser.mockResolvedValue({
      id: "azure-user",
      displayName: "QA Owner",
      uniqueName: "qa@old-org.visualstudio.com",
    });
    const provider = new PatAuthProvider();
    await expect(provider.authenticate({
      organizationUrl: "https://old-org.visualstudio.com",
      personalAccessToken: "pat",
    })).resolves.toEqual({
      azureIdentityId: "azure-user",
      displayName: "QA Owner",
      emailOrUniqueName: "qa@old-org.visualstudio.com",
    });
  });

  it("falls back to the Azure identity id when neither email nor uniqueName is present", async () => {
    fetchAuthenticatedUser.mockResolvedValue({
      id: "azure-user",
      displayName: "QA Owner",
    });
    const provider = new PatAuthProvider();
    await expect(provider.authenticate({
      organizationUrl: "https://dev.azure.com/demo",
      personalAccessToken: "pat",
    })).resolves.toEqual({
      azureIdentityId: "azure-user",
      displayName: "QA Owner",
      emailOrUniqueName: "azure-user",
    });
  });

  it("does not leak upstream rejection details", async () => {
    fetchAuthenticatedUser.mockRejectedValue(new Error("secret response"));
    await expect(new PatAuthProvider().authenticate({
      organizationUrl: "https://dev.azure.com/demo",
      personalAccessToken: "bad",
    })).rejects.toThrow("rejected the Personal Access Token");
  });

  it("rejects a response without a stable Azure identity", async () => {
    fetchAuthenticatedUser.mockResolvedValue({ displayName: "Unknown" });
    await expect(new PatAuthProvider().authenticate({
      organizationUrl: "https://dev.azure.com/demo",
      personalAccessToken: "pat",
    })).rejects.toThrow("did not return an identity");
  });
});
