import "server-only";

import type { DatabaseExecutor, DatabaseExecutorConfig } from "./database-executor.port";
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
