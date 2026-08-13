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

/**
 * Platform ceiling for SELECT result sets. Enforced on the statement itself
 * (LIMIT/TOP via the AST) so drivers never buffer an unbounded result; the
 * preview bound in boundedDatabaseRows stays as a second, smaller cap.
 */
export const MAX_SELECT_ROWS = 500;

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
  /**
   * Driver-canonicalized "schema.table" keys discovered for this run. When
   * supplied, every referenced object must be one of them — the discovered
   * set bounds reads and mutations alike.
   */
  allowedTables?: ReadonlySet<string>;
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
    throw new DatabaseExecutorError("SQL could not be parsed safely for the configured driver.", "policy", false, error, "sql-parse-failed");
  }
  if (Array.isArray(ast)) throw policy("Exactly one SQL statement is allowed.");
  const type = stringField(ast, "type").toLowerCase();
  const allowedTypes = input.intent === "select" ? ["select"] : ["insert", "update", "delete"];
  if (!allowedTypes.includes(type)) {
    throw policy(input.intent === "select" ? "Only SELECT is allowed for read actions." : "Approved mutations may use only INSERT, UPDATE, or DELETE.");
  }
  if (input.intent === "select" && hasNonEmptyInto(ast)) throw policy("SELECT INTO is not allowed.");
  // An UPDATE/DELETE without a WHERE clause rewrites or removes an entire
  // table. This is a hard block: WHERE-less statements are never executed.
  // (A WHERE clause is the tester's boundary, not a row ceiling — a run
  // authorized to change data may legitimately match many rows.)
  if ((type === "update" || type === "delete") && !hasWhereClause(ast)) {
    throw policy("UPDATE and DELETE statements must include a WHERE clause.");
  }

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
    if (input.allowedTables && !input.allowedTables.has(`${schema.toLowerCase()}.${(tableName ?? "").toLowerCase()}`)) {
      throw policy(`Table "${schema}.${tableName ?? "unknown"}" is not among the discovered database objects for this run.`);
    }
  }

  // Bound SELECT result sets on the statement itself. A select that cannot be
  // safely bounded is rejected — never executed unbounded.
  const boundedSql = input.intent === "select"
    ? enforceSelectRowBound(sql, ast, input.driver)
    : sql;

  // Parameter placeholders are scanned with string literals and quoted
  // identifiers masked, so ':name' inside a literal is never treated as a
  // bind parameter (and never rewritten by compileNamedParameters).
  const parameterNames = findParameterSites(boundedSql, input.driver).map((site) => site.name);
  const unique = [...new Set(parameterNames)];
  const missing = unique.find((name) => !Object.prototype.hasOwnProperty.call(input.parameters, name));
  if (missing) throw policy(`SQL parameter ":${missing}" has no bound value.`);
  const extra = Object.keys(input.parameters).find((name) => !unique.includes(name));
  if (extra) throw policy(`Parameter "${extra}" is not declared by the SQL template.`);
  for (const [name, value] of Object.entries(input.parameters)) {
    if (!isScalarParameter(value)) {
      throw new DatabaseExecutorError(
        `Parameter "${name}" must be a scalar string, finite number, boolean, or null.`,
        "policy",
        false,
        undefined,
        "non-scalar-parameter",
      );
    }
  }

  return {
    sql: boundedSql,
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
  // Position-based replacement over literal-masked sites: a ':name' inside a
  // string literal is left untouched instead of being rewritten into a
  // driver placeholder.
  const sites = findParameterSites(validated.sql, driver);
  let sql = "";
  let cursor = 0;
  for (const site of sites) {
    sql += validated.sql.slice(cursor, site.start);
    cursor = site.end;
    if (driver === "sqlserver") {
      const parameterName = `p_${site.name}`;
      named[parameterName] = parameters[site.name];
      sql += `@${parameterName}`;
    } else if (driver === "postgres") {
      let position = positions.get(site.name);
      if (!position) {
        ordered.push(parameters[site.name]);
        position = ordered.length;
        positions.set(site.name, position);
      }
      sql += `$${position}`;
    } else {
      ordered.push(parameters[site.name]);
      sql += "?";
    }
  }
  sql += validated.sql.slice(cursor);
  return { sql, ordered, named };
}

/* ------------------------------------------------------------------------ *
 * SELECT row bounding (AST-based; never string rewriting)
 * ------------------------------------------------------------------------ */

function enforceSelectRowBound(sql: string, ast: unknown, driver: DatabaseDriverName): string {
  const target = lastSetOperand(ast);
  const bound = readRowBound(target);
  if (bound.kind === "top-percent") {
    throw rejectUnbounded(`TOP ... PERCENT cannot be bounded; use TOP with at most ${MAX_SELECT_ROWS} rows.`);
  }
  if (bound.kind === "non-literal") {
    throw rejectUnbounded(`The row limit must be a literal number of at most ${MAX_SELECT_ROWS}.`);
  }
  if (bound.kind === "literal" && bound.value <= MAX_SELECT_ROWS) return sql;

  // No bound, or an oversized one: inject/clamp on the AST and regenerate.
  applyRowBound(target, driver, bound);
  let regenerated: string;
  try {
    regenerated = parser.sqlify(ast as Parameters<Parser["sqlify"]>[0], { database: DIALECT[driver] });
  } catch {
    throw rejectUnbounded(`The SELECT could not be safely bounded; add an explicit LIMIT of at most ${MAX_SELECT_ROWS} rows.`);
  }
  // Round-trip sanity: the bounded statement must re-parse and must not have
  // gained or lost bind parameters.
  try {
    parser.astify(regenerated, { database: DIALECT[driver] });
  } catch {
    throw rejectUnbounded(`The SELECT could not be safely bounded; add an explicit LIMIT of at most ${MAX_SELECT_ROWS} rows.`);
  }
  const before = new Set(findParameterSites(sql, driver).map((site) => site.name));
  const after = new Set(findParameterSites(regenerated, driver).map((site) => site.name));
  if (before.size !== after.size || [...before].some((name) => !after.has(name))) {
    throw rejectUnbounded(`The SELECT could not be safely bounded; add an explicit LIMIT of at most ${MAX_SELECT_ROWS} rows.`);
  }
  return regenerated;
}

function rejectUnbounded(message: string) {
  return new DatabaseExecutorError(message, "policy", false, undefined, "select-unbounded");
}

/** The set-operation member that owns the trailing LIMIT (last in `_next`). */
function lastSetOperand(ast: unknown): Record<string, unknown> {
  let current = ast as Record<string, unknown>;
  let guard = 0;
  while (current && typeof current === "object" && current._next && typeof current._next === "object" && guard < 50) {
    current = current._next as Record<string, unknown>;
    guard += 1;
  }
  return current;
}

type RowBound =
  | { kind: "none" }
  | { kind: "literal"; value: number; node: Record<string, unknown> }
  | { kind: "non-literal" }
  | { kind: "top-percent" };

function readRowBound(target: Record<string, unknown>): RowBound {
  const top = target.top as Record<string, unknown> | null | undefined;
  if (top && typeof top === "object") {
    if (top.percent) return { kind: "top-percent" };
    const value = numericNodeValue(top);
    if (value === null) return { kind: "non-literal" };
    return { kind: "literal", value, node: top };
  }
  const limit = target.limit as { seperator?: string; value?: unknown[] } | null | undefined;
  if (limit && typeof limit === "object" && Array.isArray(limit.value) && limit.value.length > 0) {
    const countNode = limitCountNode(limit);
    if (!countNode) return { kind: "non-literal" };
    const value = numericNodeValue(countNode);
    if (value === null) return { kind: "non-literal" };
    return { kind: "literal", value, node: countNode };
  }
  return { kind: "none" };
}

/** MySQL `LIMIT offset, count` puts the count second; `LIMIT n OFFSET m` first. */
function limitCountNode(limit: { seperator?: string; value?: unknown[] }): Record<string, unknown> | null {
  const values = (limit.value ?? []).filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object");
  if (values.length === 0) return null;
  if (values.length === 1) return values[0];
  return limit.seperator === "," ? values[1] : values[0];
}

function numericNodeValue(node: Record<string, unknown>): number | null {
  const value = node.value;
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0 ? value : null;
}

function applyRowBound(target: Record<string, unknown>, driver: DatabaseDriverName, bound: RowBound): void {
  if (bound.kind === "literal") {
    bound.node.value = MAX_SELECT_ROWS;
    return;
  }
  if (driver === "sqlserver") {
    target.top = { value: MAX_SELECT_ROWS, percent: null, parentheses: true };
    return;
  }
  target.limit = { seperator: "", value: [{ type: "number", value: MAX_SELECT_ROWS }] };
}

/* ------------------------------------------------------------------------ *
 * Literal-aware parameter sites
 * ------------------------------------------------------------------------ */

type ParameterSite = { name: string; start: number; end: number };

function findParameterSites(sql: string, driver: DatabaseDriverName): ParameterSite[] {
  const masked = maskQuotedSpans(sql, driver);
  const sites: ParameterSite[] = [];
  for (const match of masked.matchAll(/(?<!:):([A-Za-z_][A-Za-z0-9_]*)/g)) {
    sites.push({ name: match[1], start: match.index, end: match.index + match[0].length });
  }
  return sites;
}

/**
 * Replace the contents of string literals and quoted identifiers with spaces
 * (positions preserved) so lexical scans never fire inside them. Comments are
 * already banned before this runs.
 */
function maskQuotedSpans(sql: string, driver: DatabaseDriverName): string {
  let output = "";
  let index = 0;
  const length = sql.length;
  while (index < length) {
    const char = sql[index];
    if (char === "'" || char === '"' || (char === "`" && driver === "mysql")) {
      const quote = char;
      output += " ";
      index += 1;
      while (index < length) {
        if (quote === "'" && driver === "mysql" && sql[index] === "\\" && index + 1 < length) {
          output += "  ";
          index += 2;
          continue;
        }
        if (sql[index] === quote && sql[index + 1] === quote) {
          output += "  ";
          index += 2;
          continue;
        }
        if (sql[index] === quote) {
          output += " ";
          index += 1;
          break;
        }
        output += " ";
        index += 1;
      }
      continue;
    }
    if (char === "[" && driver === "sqlserver") {
      output += " ";
      index += 1;
      while (index < length && sql[index] !== "]") {
        output += " ";
        index += 1;
      }
      if (index < length) {
        output += " ";
        index += 1;
      }
      continue;
    }
    output += char;
    index += 1;
  }
  return output;
}

function isScalarParameter(value: unknown): boolean {
  if (value === null) return true;
  const type = typeof value;
  if (type === "string" || type === "boolean") return true;
  if (type === "number") return Number.isFinite(value as number);
  return false;
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

/** True when an UPDATE/DELETE AST carries a WHERE node of any shape. */
function hasWhereClause(ast: unknown) {
  if (!ast || typeof ast !== "object") return false;
  const where = (ast as Record<string, unknown>).where;
  return where !== null && where !== undefined;
}

function policy(message: string) {
  return new DatabaseExecutorError(message, "policy", false, undefined, "sql-policy");
}
