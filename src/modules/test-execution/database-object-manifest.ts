import { databaseObjectKey } from "@/modules/integrations/database-automation/database-executor.shared";
import type {
  DatabaseAccess,
  DiscoveredDatabaseObject,
} from "@/modules/integrations/database-automation/database-executor.port";

/**
 * Render the discovered database objects most relevant to one step. Mirrors
 * the capability-manifest ranking: token overlap against the step context,
 * bounded so a large schema cannot crowd out the rest of the prompt. Names
 * and types only — never row data.
 */

export const MAX_DB_OBJECT_MANIFEST_CHARS = 6_000;
const MAX_MANIFEST_TABLES = 30;
const MAX_MANIFEST_COLUMNS_PER_TABLE = 40;

export function databaseAccessFromObjects(
  objects: readonly DiscoveredDatabaseObject[],
): DatabaseAccess {
  return {
    schemas: [...new Set(objects.map((object) => object.schema))],
    tables: new Set(objects.map((object) => databaseObjectKey(object.schema, object.table))),
  };
}

export function boundedDatabaseObjectManifest(
  objects: readonly DiscoveredDatabaseObject[],
  stepContext: string,
): string[] {
  const lines: string[] = [];
  let used = 0;
  for (const object of rankDatabaseObjects(objects, stepContext).slice(0, MAX_MANIFEST_TABLES)) {
    const columns = object.columns
      .slice(0, MAX_MANIFEST_COLUMNS_PER_TABLE)
      .map((column) => `${promptSafeText(column.name)}: ${promptSafeText(column.dataType)}`)
      .join(", ");
    const suffix = object.columns.length > MAX_MANIFEST_COLUMNS_PER_TABLE ? ", …" : "";
    const line = `- ${promptSafeText(object.schema)}.${promptSafeText(object.table)} (${columns}${suffix})`;
    if (used + line.length > MAX_DB_OBJECT_MANIFEST_CHARS) break;
    lines.push(line);
    used += line.length;
  }
  return lines;
}

/** Keep large schemas useful without listing every table in every model call. */
function rankDatabaseObjects(
  objects: readonly DiscoveredDatabaseObject[],
  stepContext: string,
): DiscoveredDatabaseObject[] {
  if (objects.length <= MAX_MANIFEST_TABLES) return [...objects];
  const tokens = [...new Set(
    stepContext
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 3),
  )].slice(0, 80);
  return objects
    .map((object, index) => {
      const haystack = [
        object.schema,
        object.table,
        ...object.columns.map((column) => column.name),
      ].join(" ").toLowerCase();
      const score = tokens.reduce((total, token) => total + (haystack.includes(token) ? 1 : 0), 0);
      return { object, index, score };
    })
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ object }) => object);
}

/** Strip control characters so a hostile identifier cannot restructure the prompt. */
function promptSafeText(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}
