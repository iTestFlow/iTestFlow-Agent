import "server-only";

import { isIP, connect, type Socket } from "node:net";

import {
  assertBoundaryEgressAllowed,
  normalizeEgressHostname,
} from "@/modules/test-execution/egress-policy.service";

import { DatabaseExecutorError, type DatabaseExecutorConfig } from "./database-executor.port";

export type DatabaseEgressBinding = {
  hostname: string;
  port: number;
  address: string;
};

/** Authorize a database endpoint and return an IP that the driver must pin. */
export async function assertDatabaseEgressAllowed(
  config: DatabaseExecutorConfig,
): Promise<DatabaseEgressBinding> {
  const target = { host: config.host, port: config.port };
  try {
    if (config.boundary) {
      const authorization = await assertBoundaryEgressAllowed(config.boundary, {
        targetKind: "database",
        protocol: "tcp",
        ...target,
      });
      return bindingFromAuthorization(target, authorization);
    }
    if (config.assertTarget) {
      const authorization = await config.assertTarget(target);
      return bindingFromAuthorization(target, authorization);
    }
    throw new Error("Execution boundary is not configured.");
  } catch (error) {
    throw new DatabaseExecutorError(
      "Database target is denied by the test-execution network policy.",
      "policy",
      false,
      error,
    );
  }
}

/** Open a TCP socket to the concrete address without another DNS lookup. */
export function connectPinnedDatabaseSocket(
  binding: DatabaseEgressBinding,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    let socket: Socket;
    try {
      socket = createPinnedDatabaseSocket(binding, signal);
    } catch (error) {
      reject(error);
      return;
    }
    const timer = setTimeout(() => {
      socket.destroy(new Error("Database connection timed out."));
    }, timeoutMs);
    const onAbort = () => socket.destroy(
      signal.reason instanceof Error ? signal.reason : new Error("Database connection was canceled."),
    );
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      socket.removeListener("error", onError);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    socket.once("error", onError);
    socket.once("connect", () => {
      cleanup();
      resolve(socket);
    });
  });
}

/** Create a connecting socket for drivers whose stream factory is synchronous. */
export function createPinnedDatabaseSocket(
  binding: DatabaseEgressBinding,
  signal: AbortSignal,
): Socket {
  if (isIP(binding.address) === 0) {
    throw new Error("The authorized database target is not an IP address.");
  }
  if (signal.aborted) {
    throw signal.reason ?? new Error("Database connection was canceled.");
  }
  const socket = connect({ host: binding.address, port: binding.port });
  const onAbort = () => socket.destroy(
    signal.reason instanceof Error ? signal.reason : new Error("Database connection was canceled."),
  );
  const cleanup = () => signal.removeEventListener("abort", onAbort);
  signal.addEventListener("abort", onAbort, { once: true });
  socket.once("connect", cleanup);
  socket.once("close", cleanup);
  return socket;
}

function bindingFromAuthorization(
  target: { host: string; port: number },
  authorization: { resolvedAddresses: string[] } | void,
): DatabaseEgressBinding {
  const address = authorization?.resolvedAddresses[0];
  if (!address || isIP(address) === 0) {
    throw new Error("The egress policy did not provide a concrete authorized address.");
  }
  return {
    hostname: normalizeEgressHostname(target.host),
    port: target.port,
    address,
  };
}
