import * as http from "node:http";
import * as https from "node:https";
import { isIP } from "node:net";

export type PinnedHttpResponse = {
  statusCode: number;
  statusText: string;
  headers: Record<string, string>;
  bytes: Buffer;
  truncated: boolean;
};

/** One fresh socket per authorized hop; URL hostname remains Host and TLS identity. */
export function requestPinnedHttp(input: {
  url: URL;
  address: string;
  method: string;
  headers: Headers;
  body?: string;
  maxResponseBytes: number;
  signal: AbortSignal;
}): Promise<PinnedHttpResponse> {
  const { url, address, method, headers, body, maxResponseBytes, signal } = input;
  if (isIP(address) === 0) throw new Error("Authorized target is not an IP address.");
  if (signal.aborted) throw signal.reason ?? new Error("Request aborted.");
  const transport = url.protocol === "https:" ? https : http;
  const outboundHeaders = Object.fromEntries(headers.entries());
  outboundHeaders.host = url.host;
  outboundHeaders["accept-encoding"] = "identity";
  const hostname = url.hostname.replace(/^\[|\]$/g, "");

  return new Promise((resolve, reject) => {
    const request = transport.request({
      protocol: url.protocol,
      hostname: address,
      port: Number(url.port) || (url.protocol === "https:" ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method,
      headers: outboundHeaders,
      agent: false,
      ...(url.protocol === "https:" && isIP(hostname) === 0 ? { servername: hostname } : {}),
    }, async (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;
      try {
        for await (const chunk of response) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          const remaining = maxResponseBytes - size;
          if (bytes.length > remaining) {
            if (remaining > 0) chunks.push(bytes.subarray(0, remaining));
            truncated = true;
            response.destroy();
            break;
          }
          chunks.push(bytes);
          size += bytes.length;
        }
        const responseHeaders: Record<string, string> = {};
        for (const [name, value] of Object.entries(response.headers)) {
          if (typeof value === "string") responseHeaders[name] = value;
          else if (Array.isArray(value)) responseHeaders[name] = value.join(", ");
        }
        resolve({ statusCode: response.statusCode ?? 0, statusText: response.statusMessage ?? "", headers: responseHeaders, bytes: Buffer.concat(chunks), truncated });
      } catch (error) { reject(error); }
    });
    const onAbort = () => request.destroy(signal.reason instanceof Error ? signal.reason : new Error("Request aborted."));
    signal.addEventListener("abort", onAbort, { once: true });
    request.once("close", () => signal.removeEventListener("abort", onAbort));
    request.once("error", reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}
