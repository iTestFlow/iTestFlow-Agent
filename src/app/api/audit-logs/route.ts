import { NextResponse } from "next/server";
import { getDatabase } from "@/modules/shared/infrastructure/database/db";

export const runtime = "nodejs";

export async function GET() {
  try {
    const db = getDatabase();
    const logs = db
      .prepare(
        `SELECT id, project_id, azure_project_id, azure_project_name, action, status, actor, message, details_json, created_at
         FROM audit_logs
         ORDER BY created_at DESC
         LIMIT 100`,
      )
      .all();

    return NextResponse.json({ logs });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Audit log fetch failed." },
      { status: 500 },
    );
  }
}
