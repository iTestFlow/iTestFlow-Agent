import type { ApiExecutorConfig } from "./api-executor.port";
import { ApiExecutorError, GuardedApiExecutor } from "./guarded-api-executor";

export type ApiConnectionCheck = { connected: boolean; authenticated: boolean; message?: string };

/** Safe preflight: never sends a state-changing request to the API target. */
export async function checkApiConnection(config: ApiExecutorConfig): Promise<ApiConnectionCheck> {
  let executor: GuardedApiExecutor | undefined;
  try {
    executor = new GuardedApiExecutor({ ...config, allowWrites: false });
    let result = await executor.execute({ method: "HEAD", path: "" });
    if (result.statusCode === 405) result = await executor.execute({ method: "GET", path: "" });
    if (result.statusCode >= 200 && result.statusCode < 400) return { connected: true, authenticated: true };
    return { connected: true, authenticated: false, message: `API returned HTTP ${result.statusCode}.` };
  } catch (error) {
    return { connected: false, authenticated: false, message: error instanceof ApiExecutorError ? error.message : "API connection check failed." };
  } finally {
    await executor?.dispose();
  }
}
