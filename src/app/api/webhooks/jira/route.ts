import { NextResponse } from "next/server";
import { verifyJiraOAuthWebhookBearer } from "@/modules/integrations/jira-cloud/jira-webhook-auth";
import { acceptJiraWebhookEvent, JiraWebhookRejectedError } from "@/modules/integrations/jira-cloud/jira-webhook-events.service";

export async function POST(request: Request) {
  try {
    await verifyJiraOAuthWebhookBearer(
      request.headers.get("authorization"),
      process.env.ATLASSIAN_OAUTH_CLIENT_SECRET ?? "",
    );
  } catch {
    return NextResponse.json({ error: "Jira webhook authentication failed." }, { status: 401 });
  }
  const rawPayload = await request.text();
  let payload: unknown;
  try { payload = JSON.parse(rawPayload); } catch {
    return NextResponse.json({ error: "Invalid Jira webhook payload." }, { status: 400 });
  }
  try {
    const result = await acceptJiraWebhookEvent({
      deliveryId: request.headers.get("x-atlassian-webhook-identifier") ?? "",
      registrationToken: new URL(request.url).searchParams.get("registration") ?? "",
      retryCount: Number(request.headers.get("x-atlassian-webhook-retry") ?? "0"),
      payload: payload as Parameters<typeof acceptJiraWebhookEvent>[0]["payload"],
      rawPayload,
    });
    return NextResponse.json(result, { status: 202 });
  } catch (error) {
    const rejected = error instanceof JiraWebhookRejectedError;
    return NextResponse.json(
      { error: rejected ? "Jira webhook delivery was rejected." : "Jira webhook delivery could not be persisted." },
      { status: rejected ? 400 : 503 },
    );
  }
}
