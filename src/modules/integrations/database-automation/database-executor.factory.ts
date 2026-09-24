import "server-only";

import { DatabaseExecutorError, type DatabaseExecutor, type DatabaseExecutorConfig } from "./database-executor.port";
import { MysqlDatabaseExecutor } from "./mysql-database-executor";
import { PostgresDatabaseExecutor } from "./postgres-database-executor";
import { SqlServerDatabaseExecutor } from "./sqlserver-database-executor";

export function createDatabaseExecutor(config: DatabaseExecutorConfig): DatabaseExecutor {
  switch (config.driver) {
    case "postgres": return new PostgresDatabaseExecutor(config);
    case "sqlserver": return new SqlServerDatabaseExecutor(config);
    case "mysql": return new MysqlDatabaseExecutor(config);
  }
}

/** Connectivity/authentication preflight; discovery uses account-visible metadata only. */
export async function checkDatabaseConnection(config: DatabaseExecutorConfig): Promise<{
  connected: boolean;
  authenticated: boolean;
  message?: string;
}> {
  const executor = createDatabaseExecutor({ ...config, allowWrites: false });
  try {
    await executor.discoverObjects();
    return { connected: true, authenticated: true };
  } catch (error) {
    if (config.signal.aborted) return { connected: false, authenticated: false, message: "Connection check was canceled." };
    const cause = error instanceof DatabaseExecutorError ? error.cause : error;
    const code = typeof cause === "object" && cause !== null && "code" in cause ? String(cause.code) : "";
    const number = typeof cause === "object" && cause !== null && "number" in cause ? Number(cause.number) : 0;
    const authenticationFailed = code === "28P01" || code === "ER_ACCESS_DENIED_ERROR" || number === 18456;
    return authenticationFailed
      ? { connected: true, authenticated: false, message: "Database authentication failed." }
      : { connected: false, authenticated: false, message: "Database connection failed." };
  } finally {
    await executor.dispose();
  }
}
