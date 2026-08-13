import "server-only";

import { jwtVerify } from "jose";

export async function verifyJiraOAuthWebhookBearer(authorization: string | null | undefined, clientSecret: string): Promise<void> {
  const match = authorization?.match(/^Bearer\s+([^\s]+)$/i);
  if (!match || !clientSecret.trim()) throw authError();
  try {
    await jwtVerify(match[1], new TextEncoder().encode(clientSecret), { algorithms: ["HS256"] });
  } catch {
    throw authError();
  }
}

function authError() { return new Error("Jira webhook authentication failed."); }
