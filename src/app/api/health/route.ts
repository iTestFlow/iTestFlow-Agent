import { NextResponse } from "next/server";
import { sqlGet } from "@/modules/shared/infrastructure/database/db";

export const runtime = "nodejs";

export async function GET() {
  try {
    await sqlGet("SELECT 1 AS ok");
    return NextResponse.json({
      status: "ok",
      database: "postgres",
      timestamp: new Date().toISOString(),
    });
  } catch {
    return NextResponse.json(
      {
        status: "error",
        database: "postgres",
        message: "Database connection failed.",
        timestamp: new Date().toISOString(),
      },
      { status: 503 },
    );
  }
}
