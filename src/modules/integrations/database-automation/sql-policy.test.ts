import { describe, expect, it } from "vitest";

import { boundedDatabaseRows } from "./database-result";
import { compileNamedParameters, validateSql } from "./sql-policy";

describe("database SQL policy", () => {
  it.each([
    ["postgres" as const, "public"],
    ["sqlserver" as const, "dbo"],
    ["mysql" as const, "testdb"],
  ])("accepts one parameterized SELECT for %s", (driver, schema) => {
    const validated = validateSql({
      sql: `SELECT id FROM ${schema}.orders WHERE id = :id`,
      intent: "select",
      driver,
      allowedSchemas: [schema],
      parameters: { id: 42 },
    });
    expect(validated.command).toBe("SELECT");
    expect(compileNamedParameters(validated, { id: 42 }, driver).sql).toMatch(driver === "postgres" ? /\$1/ : driver === "sqlserver" ? /@p_id/ : /\?/);
  });

  it("rejects DDL, multiple statements, SELECT INTO, and out-of-scope schemas", () => {
    const base = { intent: "select" as const, driver: "postgres" as const, allowedSchemas: ["public"], parameters: {} };
    expect(() => validateSql({ ...base, sql: "DROP TABLE public.orders" })).toThrow("forbidden");
    expect(() => validateSql({ ...base, sql: "SELECT 1; SELECT 2" })).toThrow("Exactly one");
    expect(() => validateSql({ ...base, sql: "SELECT * INTO backup FROM public.orders" })).toThrow();
    expect(() => validateSql({ ...base, sql: "SELECT * FROM private.orders" })).toThrow("outside");
  });

  it.each([
    ["postgres" as const, "SELECT id FROM public.orders -- policy bypass"],
    ["sqlserver" as const, "SELECT id FROM dbo.orders /* policy bypass */"],
    ["mysql" as const, "SELECT id FROM testdb.orders # policy bypass"],
    ["mysql" as const, "SELECT 1 /*!50000 UNION SELECT LOAD_FILE('/etc/passwd') */"],
    ["mysql" as const, "SELECT 1 /*M!100100 INTO OUTFILE '/tmp/export' */"],
  ])("rejects comments before parsing for %s", (driver, sql) => {
    expect(() => validateSql({
      sql,
      intent: "select",
      driver,
      allowedSchemas: [driver === "postgres" ? "public" : driver === "sqlserver" ? "dbo" : "testdb"],
      parameters: {},
    })).toThrow("comments are not allowed");
  });

  it("rejects unqualified base tables and CTE ambiguity instead of trusting a default schema", () => {
    const base = { intent: "select" as const, driver: "postgres" as const, allowedSchemas: ["public"], parameters: {} };
    expect(() => validateSql({ ...base, sql: "SELECT id FROM orders" })).toThrow("schema-qualified");
    expect(() => validateSql({
      ...base,
      sql: "WITH scoped AS (SELECT id FROM public.orders) SELECT id FROM scoped",
    })).toThrow("CTE table references are not supported");
  });

  it.each([
    ["postgres" as const, "SELECT pg_catalog.pg_read_file('/etc/passwd')"],
    ["postgres" as const, "SELECT pg_catalog.pg_ls_dir('/tmp')"],
    ["postgres" as const, "SELECT dblink('host=attacker', 'SELECT 1')"],
    ["mysql" as const, "SELECT LOAD_FILE('/etc/passwd')"],
    ["sqlserver" as const, "SELECT * FROM OPENROWSET(BULK 'file', SINGLE_CLOB) AS data"],
    ["sqlserver" as const, "EXEC xp_cmdshell 'whoami'"],
  ])("rejects dangerous server/file/network capability for %s", (driver, sql) => {
    expect(() => validateSql({
      sql,
      intent: "select",
      driver,
      allowedSchemas: [driver === "postgres" ? "public" : driver === "sqlserver" ? "dbo" : "testdb"],
      parameters: {},
    })).toThrow("forbidden database capability");
  });

  it("allows only INSERT/UPDATE/DELETE in approved mutation mode and exact bindings", () => {
    expect(validateSql({
      sql: "UPDATE public.orders SET status=:status WHERE id=:id",
      intent: "mutation",
      driver: "postgres",
      allowedSchemas: ["public"],
      parameters: { status: "ready", id: 1 },
    }).command).toBe("UPDATE");
    expect(() => validateSql({
      sql: "UPDATE public.orders SET status=:status",
      intent: "mutation",
      driver: "postgres",
      allowedSchemas: ["public"],
      parameters: {},
    })).toThrow("no bound value");
  });

  it("caps rows and redacts sensitive columns", () => {
    const result = boundedDatabaseRows([
      { id: 1, password: "pw" },
      { id: 2, password: "pw2" },
    ], 1, 10_000);
    expect(result.truncated).toBe(true);
    expect(result.rows).toEqual([{ id: 1, password: "pw" }]);
    expect(result.safeRows).toEqual([{ id: 1, password: "[REDACTED]" }]);
  });
});
