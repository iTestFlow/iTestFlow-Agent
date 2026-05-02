import "server-only";

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

let instance: DatabaseSync | undefined;

export function getDatabase() {
  if (instance) return instance;

  const dbPath = join(process.cwd(), "data", "itestflow.sqlite");
  mkdirSync(dirname(dbPath), { recursive: true });

  instance = new DatabaseSync(dbPath);
  instance.exec("PRAGMA journal_mode = WAL");
  instance.exec("PRAGMA foreign_keys = ON");

  const schema = readFileSync(join(process.cwd(), "src", "modules", "shared", "infrastructure", "database", "schema.sql"), "utf8");
  instance.exec(schema);

  return instance;
}

export function nowIso() {
  return new Date().toISOString();
}

export function createId(prefix: string) {
  return `${prefix}_${randomUUID()}`;
}
