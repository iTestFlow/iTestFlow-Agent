import { afterAll, beforeAll, expect, it } from "vitest";

import { sqlRun, resetDatabaseForTests } from "@/modules/shared/infrastructure/database/db";
import { describeDb, uniqueTestId } from "@/test/db";
import { authorizeEgressTarget, type EgressBoundary } from "@/modules/integrations/api-automation/egress-boundary";
import { createDatabaseExecutor } from "./database-executor.factory";
import type { DatabaseExecutorConfig } from "./database-executor.port";

const table = uniqueTestId("pw_live");
const url = new URL(process.env.DATABASE_URL ?? "postgresql://itestflow:itestflow@localhost:5433/itestflow_test");
const host = url.hostname;
const port = Number(url.port || 5432);
const boundary: EgressBoundary = {
  targets: [{ kind: "db", protocol: "tcp", host, port }],
  privateCidrs: ["127.0.0.0/8", "::1/128"],
};

function config(allowWrites: boolean): DatabaseExecutorConfig {
  return {
    driver: "postgres", host, port, databaseName: url.pathname.slice(1), username: decodeURIComponent(url.username),
    tlsMode: "disable", connectTimeoutMs: 5_000, statementTimeoutMs: 5_000, allowWrites,
    credentials: { password: decodeURIComponent(url.password) }, signal: new AbortController().signal,
    authorizeTarget: (target) => authorizeEgressTarget(boundary, { kind: "db", protocol: "tcp", ...target }),
  };
}

describeDb("PostgreSQL execution adapter (live)", () => {
  beforeAll(async () => {
    await sqlRun(`CREATE TABLE public.${table} (id integer PRIMARY KEY, password text NOT NULL)`);
  });
  afterAll(async () => {
    await sqlRun(`DROP TABLE IF EXISTS public.${table}`);
    await resetDatabaseForTests();
  });

  it("binds parameters, enforces write opt-in, and keeps sensitive rows private", async () => {
    const readOnly = createDatabaseExecutor(config(false));
    const writer = createDatabaseExecutor(config(true));
    try {
      const visible = await writer.discoverObjects();
      const object = visible.objects.find((entry) => entry.schema === "public" && entry.table === table);
      expect(object?.columns.map((column) => column.name)).toEqual(["id", "password"]);
      const access = { schemas: ["public"], tables: new Set([`public.${table}`]) };
      writer.setDatabaseAccess(access);
      readOnly.setDatabaseAccess(access);

      await expect(readOnly.execute({ kind: "mutation", sql: `INSERT INTO public.${table} (id, password) VALUES (:id, :password)`,
        parameters: { id: 1, password: "private-token" } })).rejects.toMatchObject({ code: "writes-disabled" });
      const inserted = await writer.execute({ kind: "mutation", sql: `INSERT INTO public.${table} (id, password) VALUES (:id, :password)`,
        parameters: { id: 1, password: "private-token" } });
      expect(inserted.status).toBe("ok");
      expect(inserted.rowCount).toBe(1);

      const selected = await readOnly.execute({ kind: "select", sql: `SELECT id, password FROM public.${table} WHERE id = :id`, parameters: { id: 1 } });
      expect(selected.status).toBe("ok");
      expect(selected.rows).toEqual([{ id: 1, password: "private-token" }]);
      expect(selected.safeRows).toEqual([{ id: 1, password: "[REDACTED]" }]);
      expect(JSON.stringify(selected)).not.toContain("private-token");

      await expect(writer.execute({ kind: "mutation", sql: `DELETE FROM public.${table}` })).rejects.toMatchObject({ category: "policy" });
      await expect(readOnly.execute({ kind: "select", sql: "SELECT * FROM pg_catalog.pg_user" })).rejects.toMatchObject({ category: "policy" });
    } finally {
      await readOnly.dispose();
      await writer.dispose();
    }
  });
});
