import "server-only";

type DatabaseSyncConstructor = new (path: string) => {
  exec: (sql: string) => unknown;
  prepare: (sql: string) => {
    all: (parameters?: unknown) => unknown[];
    get: (parameters?: unknown) => unknown;
    run: (parameters?: unknown) => unknown;
  };
};
type CryptoModule = typeof import("crypto");
type FsModule = typeof import("fs");
type PathModule = typeof import("path");

let instance: InstanceType<DatabaseSyncConstructor> | undefined;

export function getDatabase() {
  if (instance) return instance;

  const fs = getFs();
  const path = getPath();
  const dbPath = path.join(process.cwd(), "data", "itestflow.sqlite");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const { DatabaseSync } = nativeRequire("node:sqlite") as { DatabaseSync: DatabaseSyncConstructor };
  instance = new DatabaseSync(dbPath);
  instance.exec("PRAGMA journal_mode = WAL");
  instance.exec("PRAGMA foreign_keys = ON");

  const schema = fs.readFileSync(path.join(process.cwd(), "src", "modules", "shared", "infrastructure", "database", "schema.sql"), "utf8");
  instance.exec(schema);

  return instance;
}

export function nowIso() {
  return new Date().toISOString();
}

export function createId(prefix: string) {
  return `${prefix}_${getCrypto().randomUUID()}`;
}

function getCrypto() {
  return nativeRequire("crypto") as CryptoModule;
}

function getFs() {
  return nativeRequire("fs") as FsModule;
}

function getPath() {
  return nativeRequire("path") as PathModule;
}

function nativeRequire(specifier: string): unknown {
  const requireFunction = eval("require") as NodeRequire;
  return requireFunction(specifier);
}
