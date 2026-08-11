import { Parser } from "node-sql-parser";

import { DatabaseExecutorError } from "./database-executor.port";

export type DatabaseDriverName = "postgres" | "sqlserver" | "mysql";
export type SqlIntent = "select" | "mutation";

const parser = new Parser();
const DIALECT: Record<DatabaseDriverName, string> = {
  postgres: "Postgresql",
  sqlserver: "TransactSQL",
  mysql: "MySQL",
};
const FORBIDDEN_SQL = /\b(drop|alter|truncate|create|grant|revoke|execute|exec|call|copy|load_file|outfile|dumpfile|openrowset|openquery|opendatasource|xp_cmdshell|xp_[a-z0-9_]*|pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file|dblink(?:_[a-z0-9_]*)?|lo_import|lo_export)\b/i;

export type ValidatedSql = {
  sql: string;
  command: "SELECT" | "INSERT" | "UPDATE" | "DELETE";
  parameterNames: string[];
};

export function validateSql(input: {
  sql: string;
  intent: SqlIntent;
  driver: DatabaseDriverName;
  allowedSchemas: readonly string[];
  parameters: Readonly<Record<string, unknown>>;
}): ValidatedSql {
  const sql = input.sql.trim().replace(/;\s*$/, "");
  if (!sql) throw policy("SQL is empty.");
  if (sql.includes(";")) throw policy("Exactly one SQL statement is allowed.");
  // Comments are rejected instead of stripped. MySQL and MariaDB execute
  // versioned comments such as /*!50000 ... */ and /*M! ... */, so stripping
  // them for policy inspection while sending the original SQL would create a
  // parser/policy differential. A blanket comment ban also keeps every
  // dialect on the same fail-closed path.
  if (containsSqlComment(sql, input.driver)) throw policy("SQL comments are not allowed.");
  if (FORBIDDEN_SQL.test(sql)) throw policy("The SQL contains a forbidden database capability.");

  let ast: unknown;
  try {
    ast = parser.astify(sql, { database: DIALECT[input.driver] });
  } catch (error) {
    throw new DatabaseExecutorError("SQL could not be parsed safely for the configured driver.", "policy", false, error);
  }
  if (Array.isArray(ast)) throw policy("Exactly one SQL statement is allowed.");
  const type = stringField(ast, "type").toLowerCase();
  const allowedTypes = input.intent === "select" ? ["select"] : ["insert", "update", "delete"];
  if (!allowedTypes.includes(type)) {
    throw policy(input.intent === "select" ? "Only SELECT is allowed for read actions." : "Approved mutations may use only INSERT, UPDATE, or DELETE.");
  }
  if (input.intent === "select" && hasNonEmptyInto(ast)) throw policy("SELECT INTO is not allowed.");

  const tables = parser.tableList(sql, { database: DIALECT[input.driver] });
  for (const table of tables) {
    const [, schema, tableName] = table.split("::");
    // Search paths/default schemas make an unqualified name impossible to
    // authorize from SQL text alone. node-sql-parser also reports CTE aliases
    // as unqualified tables, so CTEs intentionally fail closed here rather
    // than creating an ambiguity an attacker could exploit.
    if (!schema || schema === "null") {
      throw policy(`Table "${tableName || "unknown"}" must be schema-qualified; CTE table references are not supported.`);
    }
    if (!input.allowedSchemas.some((allowed) => allowed.toLowerCase() === schema.toLowerCase())) {
      throw policy(`Schema "${schema}" is outside the environment allowlist.`);
    }
  }

  const parameterNames = [...sql.matchAll(/(?<!:):([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => match[1]);
  const unique = [...new Set(parameterNames)];
  const missing = unique.find((name) => !Object.prototype.hasOwnProperty.call(input.parameters, name));
  if (missing) throw policy(`SQL parameter ":${missing}" has no bound value.`);
  const extra = Object.keys(input.parameters).find((name) => !unique.includes(name));
  if (extra) throw policy(`Parameter "${extra}" is not declared by the SQL template.`);

  return {
    sql,
    command: type.toUpperCase() as ValidatedSql["command"],
    parameterNames,
  };
}

export function compileNamedParameters(
  validated: ValidatedSql,
  parameters: Readonly<Record<string, unknown>>,
  driver: DatabaseDriverName,
) {
  const ordered: unknown[] = [];
  const named: Record<string, unknown> = {};
  const positions = new Map<string, number>();
  const sql = validated.sql.replace(/(?<!:):([A-Za-z_][A-Za-z0-9_]*)/g, (_, name: string) => {
    if (driver === "sqlserver") {
      const parameterName = `p_${name}`;
      named[parameterName] = parameters[name];
      return `@${parameterName}`;
    }
    if (driver === "postgres") {
      let position = positions.get(name);
      if (!position) {
        ordered.push(parameters[name]);
        position = ordered.length;
        positions.set(name, position);
      }
      return `$${position}`;
    }
    ordered.push(parameters[name]);
    return "?";
  });
  return { sql, ordered, named };
}

function containsSqlComment(sql: string, driver: DatabaseDriverName): boolean {
  // Deliberately lexical rather than quote-aware. Treating comment openers in
  // string literals as harmless would require reproducing three databases'
  // escape-mode settings exactly; a conservative false positive is safer than
  // a policy/parser/server differential at this boundary.
  return sql.includes("--") || sql.includes("/*") || (driver === "mysql" && sql.includes("#"));
}

function stringField(value: unknown, key: string) {
  if (!value || typeof value !== "object") return "";
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : "";
}

function hasNonEmptyInto(ast: unknown) {
  if (!ast || typeof ast !== "object") return false;
  const into = (ast as Record<string, unknown>).into;
  if (!into) return false;
  if (typeof into !== "object") return true;
  return Object.values(into as Record<string, unknown>).some((value) => value !== null && value !== undefined && value !== "");
}

function policy(message: string) {
  return new DatabaseExecutorError(message, "policy");
}
