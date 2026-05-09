import { NextResponse } from "next/server";
import { getDatabase } from "@/modules/shared/infrastructure/database/db";

export const runtime = "nodejs";

export async function GET() {
  try {
    const db = getDatabase();
    const logs = db
      .prepare(
        `SELECT id, project_id, azure_project_id, azure_project_name, target_work_item_id,
                action, provider, model_name, schema_name, prompt_name, prompt_version,
                system_prompt, user_prompt, request_body_json, response_body_json,
                raw_output, validated_output_json, status, error_details, duration_ms,
                created_at
         FROM llm_request_logs
         ORDER BY created_at DESC
         LIMIT 100`,
      )
      .all();

    return NextResponse.json({ logs });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "LLM request log fetch failed." },
      { status: 500 },
    );
  }
}
