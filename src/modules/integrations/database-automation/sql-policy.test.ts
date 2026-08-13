import { describe, expect, it } from "vitest";

import { boundedDatabaseRows } from "./database-result";
import { compileNamedParameters, MAX_SELECT_ROWS, validateSql } from "./sql-policy";

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
      sql: "UPDATE public.orders SET status=:status WHERE id=:id",
      intent: "mutation",
      driver: "postgres",
      allowedSchemas: ["public"],
      parameters: {},
    })).toThrow("no bound value");
  });

  it("blocks WHERE-less UPDATE and DELETE statements", () => {
    // A WHERE-less statement rewrites or removes a whole table. This is a hard
    // block; a WHERE clause that matches many rows stays the tester's call.
    for (const sql of [
      "UPDATE public.orders SET status='closed'",
      "DELETE FROM public.orders",
    ]) {
      expect(() => validateSql({
        sql,
        intent: "mutation",
        driver: "postgres",
        allowedSchemas: ["public"],
        parameters: {},
      })).toThrow("must include a WHERE clause");
    }
    // INSERT is unaffected, and a broad WHERE is authorized by the tester.
    expect(validateSql({
      sql: "INSERT INTO public.orders (id) VALUES (:id)",
      intent: "mutation",
      driver: "postgres",
      allowedSchemas: ["public"],
      parameters: { id: 1 },
    }).command).toBe("INSERT");
    expect(validateSql({
      sql: "DELETE FROM public.orders WHERE 1=1",
      intent: "mutation",
      driver: "postgres",
      allowedSchemas: ["public"],
      parameters: {},
    }).command).toBe("DELETE");
  });

  it("bounds reads and mutations to the discovered objects when one is supplied", () => {
    const allowedTables = new Set(["public.orders"]);
    expect(validateSql({
      sql: "SELECT id FROM public.orders LIMIT 10",
      intent: "select",
      driver: "postgres",
      allowedSchemas: ["public"],
      allowedTables,
      parameters: {},
    }).command).toBe("SELECT");
    for (const [sql, intent] of [
      ["SELECT id FROM public.customers LIMIT 10", "select"],
      ["DELETE FROM public.customers WHERE id=:id", "mutation"],
    ] as const) {
      expect(() => validateSql({
        sql,
        intent,
        driver: "postgres",
        allowedSchemas: ["public"],
        allowedTables,
        parameters: intent === "mutation" ? { id: 1 } : {},
      })).toThrow("not among the discovered database objects");
    }
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

  describe("select row bounding", () => {
    const base = { intent: "select" as const, allowedSchemas: ["app"], parameters: {} };

    it.each([
      ["postgres" as const],
      ["mysql" as const],
    ])("injects LIMIT %s when a select has none", (driver) => {
      const validated = validateSql({ ...base, driver, sql: "SELECT id FROM app.orders" });
      expect(validated.sql).toMatch(new RegExp(`LIMIT\\s+${MAX_SELECT_ROWS}`, "i"));
    });

    it("injects TOP for sqlserver when a select has none", () => {
      const validated = validateSql({ ...base, driver: "sqlserver", sql: "SELECT id FROM app.orders" });
      expect(validated.sql).toMatch(new RegExp(`TOP\\s*\\(?${MAX_SELECT_ROWS}\\)?`, "i"));
    });

    it("preserves an existing limit at or below the platform maximum", () => {
      const validated = validateSql({ ...base, driver: "mysql", sql: "SELECT id FROM app.orders LIMIT 10" });
      expect(validated.sql).toMatch(/LIMIT\s+10/i);
      expect(validated.sql).not.toMatch(new RegExp(String(MAX_SELECT_ROWS)));
    });

    it.each([
      ["mysql" as const, "SELECT id FROM app.orders LIMIT 1000000"],
      ["postgres" as const, "SELECT id FROM app.orders LIMIT 1000000"],
      ["sqlserver" as const, "SELECT TOP (1000000) id FROM app.orders"],
    ])("clamps an oversized limit for %s", (driver, sql) => {
      const validated = validateSql({ ...base, driver, sql });
      expect(validated.sql).toMatch(new RegExp(String(MAX_SELECT_ROWS)));
      expect(validated.sql).not.toMatch(/1000000/);
    });

    it("clamps the count of a two-part mysql LIMIT offset, count", () => {
      const validated = validateSql({ ...base, driver: "mysql", sql: "SELECT id FROM app.orders LIMIT 5, 999999" });
      expect(validated.sql).toMatch(new RegExp(String(MAX_SELECT_ROWS)));
      expect(validated.sql).not.toMatch(/999999/);
    });

    it("keeps bind parameters intact when bounding", () => {
      const validated = validateSql({
        ...base,
        driver: "postgres",
        sql: "SELECT id FROM app.orders WHERE id = :id",
        parameters: { id: 7 },
      });
      expect(validated.parameterNames).toEqual(["id"]);
      expect(validated.sql).toMatch(new RegExp(`LIMIT\\s+${MAX_SELECT_ROWS}`, "i"));
      expect(compileNamedParameters(validated, { id: 7 }, "postgres").ordered).toEqual([7]);
    });

    it("rejects TOP PERCENT instead of executing unbounded", () => {
      expect(() => validateSql({ ...base, driver: "sqlserver", sql: "SELECT TOP 50 PERCENT id FROM app.orders" }))
        .toThrow(/PERCENT/i);
    });

    it("bounds a UNION select on its trailing member", () => {
      const validated = validateSql({
        ...base,
        driver: "mysql",
        sql: "SELECT name FROM app.users UNION SELECT name FROM app.orders",
      });
      expect(validated.sql).toMatch(new RegExp(`LIMIT\\s+${MAX_SELECT_ROWS}`, "i"));
    });

    it("never bounds mutations", () => {
      const validated = validateSql({
        intent: "mutation",
        driver: "postgres",
        allowedSchemas: ["app"],
        parameters: { id: 1 },
        sql: "DELETE FROM app.orders WHERE id = :id",
      });
      expect(validated.sql).not.toMatch(/LIMIT/i);
    });
  });

  describe("scalar-only parameters", () => {
    const base = {
      intent: "select" as const,
      driver: "postgres" as const,
      allowedSchemas: ["app"],
      sql: "SELECT id FROM app.orders WHERE id = :id",
    };

    it.each([
      ["object", { a: 1 }],
      ["array", [1, 2]],
      ["NaN", Number.NaN],
      ["Infinity", Number.POSITIVE_INFINITY],
    ])("rejects %s parameter values", (_label, value) => {
      expect(() => validateSql({ ...base, parameters: { id: value } })).toThrow(/scalar/);
    });

    it.each([
      ["string", "x"],
      ["number", 42],
      ["boolean", true],
      ["null", null],
    ])("accepts %s parameter values", (_label, value) => {
      expect(validateSql({ ...base, parameters: { id: value } }).parameterNames).toEqual(["id"]);
    });
  });

  describe("literal-aware parameter scanning", () => {
    it("ignores :name inside string literals for presence checks", () => {
      const validated = validateSql({
        sql: "SELECT id FROM app.orders WHERE note = 'ratio 1:n' AND id = :id",
        intent: "select",
        driver: "postgres",
        allowedSchemas: ["app"],
        parameters: { id: 5 },
      });
      expect(validated.parameterNames).toEqual(["id"]);
    });

    it("never rewrites :name inside a string literal during compilation", () => {
      const validated = validateSql({
        sql: "SELECT id FROM app.orders WHERE note = 'a:b' AND id = :id LIMIT 5",
        intent: "select",
        driver: "mysql",
        allowedSchemas: ["app"],
        parameters: { id: 5 },
      });
      const compiled = compileNamedParameters(validated, { id: 5 }, "mysql");
      expect(compiled.sql).toContain("'a:b'");
      expect(compiled.sql).toContain("?");
      expect(compiled.ordered).toEqual([5]);
    });

    it("treats a parameter used only inside a literal as undeclared", () => {
      expect(() => validateSql({
        sql: "SELECT id FROM app.orders WHERE note = ':id'",
        intent: "select",
        driver: "postgres",
        allowedSchemas: ["app"],
        parameters: { id: 5 },
      })).toThrow(/not declared/);
    });
  });
});
