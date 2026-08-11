import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

import { requestPinnedHttp } from "./pinned-http-transport";

describe("requestPinnedHttp", () => {
  it("rejects unsupported protocols and pre-aborted calls before opening a socket", async () => {
    await expect(requestPinnedHttp(
      new URL("ftp://example.test/file"),
      { method: "GET" },
      "127.0.0.1",
    )).rejects.toThrow("HTTP and HTTPS");

    const controller = new AbortController();
    controller.abort("already canceled");
    await expect(requestPinnedHttp(
      new URL("http://example.test/file"),
      { method: "GET", signal: controller.signal },
      "127.0.0.1",
    )).rejects.toBe("already canceled");
  });

  it("connects to the authorized IP while preserving Host and the request target", async () => {
    const server = createServer();
    const observed = new Promise<{ host: string | undefined; url: string | undefined }>((resolve) => {
      server.once("request", (request, response) => {
        resolve({ host: request.headers.host, url: request.url });
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("ok");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const response = await requestPinnedHttp(
        new URL(`http://does-not-resolve.invalid:${port}/v1/orders?id=42`),
        { method: "GET" },
        "127.0.0.1",
      );

      expect(await response.text()).toBe("ok");
      await expect(observed).resolves.toEqual({
        host: `does-not-resolve.invalid:${port}`,
        url: "/v1/orders?id=42",
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("rejects a non-IP authorization result before opening transport", async () => {
    await expect(requestPinnedHttp(
      new URL("http://example.test/resource"),
      { method: "GET" },
      "rebinding.example.test",
    )).rejects.toThrow("not an IP address");
  });

  it("sends buffered request bodies and preserves an explicit content encoding", async () => {
    const server = createServer();
    const observed = new Promise<{ body: string; encoding: string | undefined }>((resolve) => {
      server.once("request", (request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        request.on("end", () => {
          resolve({ body: Buffer.concat(chunks).toString("utf8"), encoding: request.headers["accept-encoding"] });
          response.writeHead(204);
          response.end();
        });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const response = await requestPinnedHttp(
        new URL(`http://write.example.test:${port}/orders`),
        { method: "POST", headers: { "Accept-Encoding": "identity-test" }, body: new Uint8Array([111, 107]) },
        "127.0.0.1",
      );
      expect(response.status).toBe(204);
      expect(await response.text()).toBe("");
      await expect(observed).resolves.toEqual({ body: "ok", encoding: "identity-test" });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("rejects streaming request bodies at the pinned transport boundary", async () => {
    await expect(requestPinnedHttp(
      new URL("http://example.test/resource"),
      { method: "POST", body: new ReadableStream() as unknown as BodyInit },
      "127.0.0.1",
    )).rejects.toThrow("buffered request bodies");
  });

  it("keeps abort wired after headers while the response body is streaming", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.flushHeaders();
      // Deliberately leave the body open; abort must tear this stream down.
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const controller = new AbortController();
      const response = await requestPinnedHttp(
        new URL(`http://stream.example.test:${port}/events`),
        { method: "GET", signal: controller.signal },
        "127.0.0.1",
      );

      controller.abort("deadline");
      await expect(response.text()).rejects.toThrow();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
