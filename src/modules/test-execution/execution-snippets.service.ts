import "server-only";

import { createId, nowIso, sqlAll, sqlGet, sqlRun } from "@/modules/shared/infrastructure/database/db";

export type ExecutionSnippet = {
  id: string;
  name: string;
  instructions: string;
  expectedResult: string;
  updatedAt: string;
};

type SnippetRow = { id: string; name: string; instructions: string; expected_result: string; updated_at: string };
const mapSnippet = (row: SnippetRow): ExecutionSnippet => ({ id: row.id, name: row.name, instructions: row.instructions, expectedResult: row.expected_result, updatedAt: row.updated_at });

export async function listExecutionSnippets(workspaceId: string, projectId: string): Promise<ExecutionSnippet[]> {
  const rows = await sqlAll<SnippetRow>(
    `SELECT id, name, instructions, expected_result, updated_at FROM playwright_execution_snippets
      WHERE workspace_id = @workspaceId AND project_id = @projectId ORDER BY lower(name)`, { workspaceId, projectId },
  );
  return rows.map(mapSnippet);
}

export async function createExecutionSnippet(input: { workspaceId: string; projectId: string; userId: string; name: string; instructions: string; expectedResult: string }): Promise<ExecutionSnippet | null> {
  const row = await sqlGet<SnippetRow>(
    `INSERT INTO playwright_execution_snippets
      (id, workspace_id, project_id, name, instructions, expected_result, created_by_user_id, updated_by_user_id, created_at, updated_at)
     VALUES (@id, @workspaceId, @projectId, @name, @instructions, @expectedResult, @userId, @userId, @now, @now)
     ON CONFLICT (workspace_id, project_id, lower(name)) DO NOTHING
     RETURNING id, name, instructions, expected_result, updated_at`,
    { id: createId("pwsnip"), ...input, name: input.name.trim(), now: nowIso() },
  );
  return row ? mapSnippet(row) : null;
}

export async function updateExecutionSnippet(id: string, input: { workspaceId: string; projectId: string; userId: string; name: string; instructions: string; expectedResult: string }): Promise<ExecutionSnippet | null> {
  const row = await sqlGet<SnippetRow>(
    `UPDATE playwright_execution_snippets SET name = @name, instructions = @instructions,
      expected_result = @expectedResult, updated_by_user_id = @userId, updated_at = @now
     WHERE id = @id AND workspace_id = @workspaceId AND project_id = @projectId
     RETURNING id, name, instructions, expected_result, updated_at`,
    { id, ...input, name: input.name.trim(), now: nowIso() },
  );
  return row ? mapSnippet(row) : null;
}

export async function deleteExecutionSnippet(id: string, workspaceId: string, projectId: string): Promise<boolean> {
  return (await sqlRun(
    `DELETE FROM playwright_execution_snippets WHERE id = @id AND workspace_id = @workspaceId AND project_id = @projectId`,
    { id, workspaceId, projectId },
  )) > 0;
}
