import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { verifyJiraOAuthWebhookBearer } from "./jira-webhook-auth";

describe("verifyJiraOAuthWebhookBearer", () => {
  it("accepts only a current HS256 token signed with the Atlassian app client secret", async () => {
    const secret = "client-secret-with-enough-entropy";
    const token = await new SignJWT({ purpose: "jira-webhook" })
      .setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("2m")
      .sign(new TextEncoder().encode(secret));
    await expect(verifyJiraOAuthWebhookBearer(`Bearer ${token}`, secret)).resolves.toBeUndefined();
    await expect(verifyJiraOAuthWebhookBearer(`Bearer ${token}`, "wrong-secret"))
      .rejects.toThrow("authentication failed");
  });

  it("rejects missing, expired, and non-bearer credentials with a fixed message", async () => {
    const secret = "client-secret-with-enough-entropy";
    const expired = await new SignJWT({}).setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(1).setExpirationTime(2).sign(new TextEncoder().encode(secret));
    await expect(verifyJiraOAuthWebhookBearer(undefined, secret)).rejects.toThrow("authentication failed");
    await expect(verifyJiraOAuthWebhookBearer(`Basic ${expired}`, secret)).rejects.toThrow("authentication failed");
    await expect(verifyJiraOAuthWebhookBearer(`Bearer ${expired}`, secret)).rejects.toThrow("authentication failed");
  });
});
