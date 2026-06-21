import { NextResponse } from "next/server";

import { ensureBootstrapOwner } from "@/modules/auth/bootstrap.service";
import { createSession } from "@/modules/auth/session.service";

export const runtime = "nodejs";

/**
 * Dev/bootstrap session creation (ADR-8). Lets the bootstrapped owner obtain a
 * session WITHOUT the full PAT-validation + encrypted-credential flow, which
 * lands in Phase 2 — so the session/workspace primitives are exercisable now.
 * Disabled when APP_MODE=hosted.
 */
export async function POST(request: Request) {
  if (process.env.APP_MODE === "hosted") {
    return NextResponse.json({ error: "Dev login is disabled in hosted mode." }, { status: 404 });
  }

  const bootstrap = await ensureBootstrapOwner();
  if (!bootstrap) {
    return NextResponse.json(
      { error: "Set BOOTSTRAP_OWNER_EMAIL and BOOTSTRAP_OWNER_AZURE_ORG to use dev login." },
      { status: 400 },
    );
  }

  await createSession({
    userId: bootstrap.userId,
    userAgent: request.headers.get("user-agent"),
  });

  return NextResponse.json({ ok: true, userId: bootstrap.userId, workspaceId: bootstrap.workspaceId });
}
