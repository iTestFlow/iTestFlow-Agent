import { NextResponse } from "next/server";
import { getDatabase } from "@/modules/shared/infrastructure/database/db";

export const runtime = "nodejs";

export async function GET() {
  getDatabase();
  return NextResponse.json({
    status: "ok",
    mode: "local-first",
    database: "sqlite",
    timestamp: new Date().toISOString(),
  });
}
