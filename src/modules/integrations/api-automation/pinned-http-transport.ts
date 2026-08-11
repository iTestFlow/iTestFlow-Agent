import "server-only";

import * as http from "node:http";
import * as https from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";

export type PinnedHttpRequest = (
  url: URL,
  init: RequestInit,
  authorizedAddress: string,
) => Promise<Response>;

/**
 * Perform one HTTP hop against an already-authorized IP address. The URL's
 * hostname is retained for the Host header and HTTPS SNI/certificate identity
 * checks, so pinning cannot be used to weaken TLS verification.
 */
export const requestPinnedHttp: PinnedHttpRequest = async (
  url,
  init,
  authorizedAddress,
) => {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only HTTP and HTTPS transports are supported.");
  }
  if (isIP(authorizedAddress) === 0) {
    throw new Error("The authorized HTTP target is not an IP address.");
  }
  const signal = init.signal;
  if (signal?.aborted) throw signal.reason ?? new Error("Request aborted.");

  const headers = Object.fromEntries(new Headers(init.headers).entries());
  // User-controlled Host is rejected before this boundary. Supplying it here
  // preserves virtual-host routing while the socket connects to the pinned IP.
  headers.host = url.host;
  // Node's low-level client does not transparently decompress responses. Ask
  // the peer for identity encoding so byte limits retain their exact meaning.
  if (!("accept-encoding" in headers)) headers["accept-encoding"] = "identity";

  const certificateHostname = stripIpv6Brackets(url.hostname);
  return new Promise<Response>((resolve, reject) => {
    const request = (url.protocol === "https:" ? https : http).request({
      protocol: url.protocol,
      hostname: authorizedAddress,
      port: Number(url.port) || (url.protocol === "https:" ? 443 : 80),
      method: init.method ?? "GET",
      path: `${url.pathname}${url.search}`,
      headers,
      agent: false,
      // HTTPS continues to validate against the configured DNS name. IP URL
      // targets are checked as IP identities and intentionally omit SNI.
      ...(url.protocol === "https:" && isIP(certificateHostname) === 0
        ? { servername: certificateHostname }
        : {}),
    }, (incoming) => {
      // ClientRequest can close as soon as headers arrive, while the response
      // stream remains open. Keep cancellation attached to IncomingMessage so
      // the caller's deadline covers bounded body consumption too.
      const onResponseAbort = () => incoming.destroy(abortReason(signal));
      signal?.addEventListener("abort", onResponseAbort, { once: true });
      incoming.once("close", () => signal?.removeEventListener("abort", onResponseAbort));
      if (signal?.aborted) onResponseAbort();
      const responseHeaders = new Headers();
      for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
        const name = incoming.rawHeaders[index];
        const value = incoming.rawHeaders[index + 1];
        if (name && value !== undefined) responseHeaders.append(name, value);
      }
      const method = (init.method ?? "GET").toUpperCase();
      const hasNoBody = method === "HEAD" || incoming.statusCode === 204 || incoming.statusCode === 205 || incoming.statusCode === 304;
      const body = hasNoBody
        ? null
        : Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
      resolve(new Response(body, {
        status: incoming.statusCode ?? 500,
        statusText: incoming.statusMessage ?? "",
        headers: responseHeaders,
      }));
    });

    const onAbort = () => request.destroy(abortReason(signal));
    signal?.addEventListener("abort", onAbort, { once: true });
    request.once("close", () => signal?.removeEventListener("abort", onAbort));
    request.once("error", reject);
    if (init.body !== undefined && init.body !== null) {
      if (typeof init.body !== "string" && !Buffer.isBuffer(init.body) && !(init.body instanceof Uint8Array)) {
        request.destroy(new Error("Pinned HTTP transport accepts only buffered request bodies."));
        return;
      }
      request.write(init.body);
    }
    request.end();
  });
};

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function abortReason(signal: AbortSignal | null | undefined): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error("Request aborted.");
}
