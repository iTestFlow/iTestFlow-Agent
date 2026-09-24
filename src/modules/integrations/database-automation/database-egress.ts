import "server-only";

import { isIP, connect, type Socket } from "node:net";
import { domainToASCII } from "node:url";

import { DatabaseExecutorError, type DatabaseExecutorConfig } from "./database-executor.port";

export type DatabaseEgressBinding = { hostname: string; port: number; address: string };

/** Authorize endpoint and return concrete IP that driver must use. */
export async function assertDatabaseEgressAllowed(config: DatabaseExecutorConfig): Promise<DatabaseEgressBinding> {
  try {
    if (!config.authorizeTarget || !config.host || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
      throw new Error("Invalid database target or missing egress authorization.");
    }
    const hostname = normalizeHostname(config.host);
    const authorization = await config.authorizeTarget({ host: hostname, port: config.port });
    const address = authorization.resolvedAddresses[0];
    if (!address || isIP(address) === 0) throw new Error("Egress policy did not return an approved IP address.");
    return { hostname, port: config.port, address };
  } catch (error) {
    throw new DatabaseExecutorError("Database target is denied by the execution network policy.", "policy", false, error);
  }
}

function normalizeHostname(value: string): string {
  const host = value.trim().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  const normalized = isIP(host) ? host : domainToASCII(host).toLowerCase();
  if (!normalized || /[\s/@\\]/.test(normalized)) throw new Error("Invalid hostname.");
  return normalized;
}

export function createPinnedDatabaseSocket(binding: DatabaseEgressBinding, signal: AbortSignal): Socket {
  if (isIP(binding.address) === 0) throw new Error("Authorized database target is not an IP address.");
  if (signal.aborted) throw signal.reason ?? new Error("Database connection was canceled.");
  const socket = connect({ host: binding.address, port: binding.port });
  const onAbort = () => socket.destroy(new Error("Database connection was canceled."));
  const cleanup = () => signal.removeEventListener("abort", onAbort);
  signal.addEventListener("abort", onAbort, { once: true });
  socket.once("connect", cleanup);
  socket.once("close", cleanup);
  return socket;
}

export function connectPinnedDatabaseSocket(binding: DatabaseEgressBinding, signal: AbortSignal, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    let socket: Socket;
    try { socket = createPinnedDatabaseSocket(binding, signal); } catch (error) { reject(error); return; }
    const timer = setTimeout(() => socket.destroy(new Error("Database connection timed out.")), timeoutMs);
    const cleanup = () => { clearTimeout(timer); socket.removeListener("error", onError); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    socket.once("error", onError);
    socket.once("connect", () => { cleanup(); resolve(socket); });
  });
}
