import { NextResponse } from "next/server";

import { destroySession } from "@/modules/auth/session.service";

export const runtime = "nodejs";

export async function POST() {
  await destroySession();
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
