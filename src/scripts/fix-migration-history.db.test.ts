import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { PoolClient } from "pg";
import { expect, it } from "vitest";

import { getPool } from "@/modules/shared/infrastructure/database/db";
import { describeDb } from "@/test/db";

import { repairMigrationHistory } from "./fix-migration-history";

type RunOnStyle = "batch" | "spread";
type HistoryRow = { id: number; name: string; run_on: string };

const migrationsDirectory = fileURLToPath(new URL("../../migrations/", import.meta.url));
const migrationNames = readdirSync(migrationsDirectory)
  .filter((file) => file.endsWith(".js"))
  .map((file) => file.slice(0, -".js".length))
  .sort();

const HISTORY_ID_BASE = 10_000_000;
const workspaceExternal = "1710000022000_workspace_external_llm_setting";
const workspaceModelLimit = "1710000023000_workspace_model_input_limit_override";
const embeddingsIndexes = "1710000023100_embeddings_indexes";
const trigramSearch = "1710000023200_trigram_search";
const sourceType = "1710000024000_embeddings_source_type";
const beforeWorkspaceMigrations = prefixThrough("1710000021000_rename_project_knowledge_job_type");
const afterSourceType = migrationNames.filter((name) => name > sourceType);

function prefixThrough(name: string): string[] {
  const index = migrationNames.indexOf(name);
  if (index === -1) throw new Error(`Migration fixture references missing file: ${name}`);
  return migrationNames.slice(0, index + 1);
}

function runOn(index: number, style: RunOnStyle): string {
  return style === "batch"
    ? "2025-01-01 00:00:00"
    : `2025-01-01 00:00:${String(index).padStart(2, "0")}`;
}

async function seedHistory(client: PoolClient, names: string[], style: RunOnStyle): Promise<void> {
  for (const [index, name] of names.entries()) {
    await client.query(
      `INSERT INTO pgmigrations (id, name, run_on) VALUES ($1, $2, $3::timestamp)`,
      [HISTORY_ID_BASE + index, name, runOn(index, style)],
    );
  }
}

async function orderedHistory(client: PoolClient): Promise<string[]> {
  const result = await client.query<{ name: string }>(
    `SELECT name FROM pgmigrations ORDER BY run_on, id`,
  );
  return result.rows.map((row) => row.name);
}

async function historySnapshot(client: PoolClient): Promise<HistoryRow[]> {
  const result = await client.query<HistoryRow>(
    `SELECT id, name, run_on::text AS run_on FROM pgmigrations ORDER BY id`,
  );
  return result.rows;
}

async function expectCheckOrderPrefix(client: PoolClient): Promise<void> {
  const history = await orderedHistory(client);
  expect(history).toEqual(migrationNames.slice(0, history.length));
}

async function expectWorkspaceColumns(client: PoolClient): Promise<void> {
  const result = await client.query<{ column_name: string }>(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'workspace_settings'
       AND column_name = ANY($1::text[])
     ORDER BY column_name`,
    [["external_llm_enabled", "model_input_token_limit_override"]],
  );
  expect(result.rows.map((row) => row.column_name)).toEqual([
    "external_llm_enabled",
    "model_input_token_limit_override",
  ]);
}

async function withHistoryFixture(
  names: string[],
  style: RunOnStyle,
  assertion: (client: PoolClient) => Promise<void>,
): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM pgmigrations");
    await seedHistory(client, names, style);
    await assertion(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

const mergeWindowHistory = [
  ...beforeWorkspaceMigrations,
  "1710000021100_embeddings_indexes",
  "1710000021200_trigram_search",
  workspaceExternal,
  workspaceModelLimit,
  ...migrationNames.filter(
    (name) => name > workspaceModelLimit && name !== embeddingsIndexes && name !== trigramSearch,
  ),
];

const forkHistory = [
  ...beforeWorkspaceMigrations,
  "1710000022000_embeddings_indexes",
  "1710000023000_trigram_search",
  sourceType,
  "1710000025000_workspace_settings_embeddings",
  "1710000026000_drop_workspace_settings_embeddings",
  ...afterSourceType,
];

const transientOnlyHistory = [
  ...beforeWorkspaceMigrations,
  "1710000021100_embeddings_indexes",
  "1710000021200_trigram_search",
  sourceType,
  ...afterSourceType,
  "1710000030000_workspace_external_llm_setting",
  "1710000031000_workspace_model_input_limit_override",
];

const transientWithCanonicalWorkspaceHistory = [
  ...beforeWorkspaceMigrations,
  "1710000021100_embeddings_indexes",
  "1710000021200_trigram_search",
  sourceType,
  ...afterSourceType,
  "1710000030000_workspace_external_llm_setting",
  "1710000031000_workspace_model_input_limit_override",
  workspaceExternal,
  workspaceModelLimit,
];

describeDb("fix migration history", () => {
  it("leaves an existing-main prefix untouched", async () => {
    await withHistoryFixture(prefixThrough(workspaceModelLimit), "spread", async (client) => {
      const before = await historySnapshot(client);

      await repairMigrationHistory(client);

      await expectCheckOrderPrefix(client);
      expect(await historySnapshot(client)).toEqual(before);
    });
  });

  it("accepts a healthy fresh database migrated in one batch", async () => {
    await withHistoryFixture(migrationNames, "batch", async (client) => {
      const before = await historySnapshot(client);

      await expect(repairMigrationHistory(client)).resolves.toBeUndefined();

      await expectCheckOrderPrefix(client);
      expect(await historySnapshot(client)).toEqual(before);
    });
  });

  it.each<RunOnStyle>(["batch", "spread"])("repairs merge-window history with %s run_on values", async (style) => {
    await withHistoryFixture(mergeWindowHistory, style, async (client) => {
      await repairMigrationHistory(client);

      await expectCheckOrderPrefix(client);
      expect(await orderedHistory(client)).toEqual(migrationNames);
      expect((await historySnapshot(client)).map((row) => row.name)).not.toContain("1710000021100_embeddings_indexes");
      expect((await historySnapshot(client)).map((row) => row.name)).not.toContain("1710000021200_trigram_search");

      const once = await historySnapshot(client);
      await repairMigrationHistory(client);
      expect(await historySnapshot(client)).toEqual(once);
    });
  });

  it("repairs fork pre-rename history and removes dead records", async () => {
    await withHistoryFixture(forkHistory, "spread", async (client) => {
      await repairMigrationHistory(client);

      await expectCheckOrderPrefix(client);
      expect(await orderedHistory(client)).toEqual(migrationNames);
      await expectWorkspaceColumns(client);
    });
  });

  it("renames transient workspace records when they are the only workspace history", async () => {
    await withHistoryFixture(transientOnlyHistory, "spread", async (client) => {
      await repairMigrationHistory(client);

      await expectCheckOrderPrefix(client);
      expect(await orderedHistory(client)).toEqual(migrationNames);
      const snapshot = await historySnapshot(client);
      expect(snapshot.filter((row) => row.name === workspaceExternal)).toHaveLength(1);
      expect(snapshot.filter((row) => row.name === workspaceModelLimit)).toHaveLength(1);
      expect(snapshot.map((row) => row.name)).not.toContain("1710000030000_workspace_external_llm_setting");
      expect(snapshot.map((row) => row.name)).not.toContain("1710000031000_workspace_model_input_limit_override");
    });
  });

  it("drops transient records when later canonical workspace records already exist", async () => {
    await withHistoryFixture(transientWithCanonicalWorkspaceHistory, "spread", async (client) => {
      await repairMigrationHistory(client);

      await expectCheckOrderPrefix(client);
      expect(await orderedHistory(client)).toEqual(migrationNames);
      const snapshot = await historySnapshot(client);
      expect(snapshot.filter((row) => row.name === workspaceExternal)).toHaveLength(1);
      expect(snapshot.filter((row) => row.name === workspaceModelLimit)).toHaveLength(1);
    });
  });

  it("applies and records workspace migrations stranded by the previous repair", async () => {
    const strandedHistory = migrationNames.filter((name) => name !== workspaceExternal && name !== workspaceModelLimit);
    await withHistoryFixture(strandedHistory, "spread", async (client) => {
      await client.query(
        `ALTER TABLE workspace_settings
         DROP COLUMN IF EXISTS external_llm_enabled,
         DROP COLUMN IF EXISTS model_input_token_limit_override`,
      );

      await repairMigrationHistory(client);

      await expectCheckOrderPrefix(client);
      expect(await orderedHistory(client)).toEqual(migrationNames);
      await expectWorkspaceColumns(client);
    });
  });

  it("leaves half-migrated and empty histories valid", async () => {
    await withHistoryFixture(prefixThrough("1710000015000_knowledge_compiler_foundation"), "spread", async (client) => {
      const before = await historySnapshot(client);
      await repairMigrationHistory(client);
      await expectCheckOrderPrefix(client);
      expect(await historySnapshot(client)).toEqual(before);
    });

    await withHistoryFixture([], "batch", async (client) => {
      await expect(repairMigrationHistory(client)).resolves.toBeUndefined();
      await expectCheckOrderPrefix(client);
    });
  });

  it("returns safely when pgmigrations does not exist in the current search path", async () => {
    await withHistoryFixture([], "batch", async (client) => {
      await client.query("SET LOCAL search_path TO pg_temp");
      await expect(repairMigrationHistory(client)).resolves.toBeUndefined();
    });
  });
});
