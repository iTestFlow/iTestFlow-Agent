import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/components/workflow/api-error";
import { nonJsonResponseDetails, postForm, postJson } from "./post-json";

/* --------------------------------------------------------------------------
 * The diagnostic contract: when a workflow POST returns a body that is NOT
 * JSON (a proxy 502/504, gateway-timeout page, or runtime HTML error page —
 * the ~240s failure signature), postJson must preserve the real HTTP status,
 * status text, Content-Type, response URL, and a body excerpt so the failing
 * layer is identifiable from the error UI's "Technical details" box. The
 * happy path must be unchanged.
 * ------------------------------------------------------------------------ */

function stubFetch(response: Response) {
  const fetchMock = vi.fn<typeof fetch>(async () => response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("postJson", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the parsed object for an ok JSON response (happy path)", async () => {
    stubFetch(new Response(JSON.stringify({ ok: true, value: 42 }), { status: 200 }));

    await expect(postJson<{ ok: boolean; value: number }>("/api/x", { a: 1 })).resolves.toEqual({
      ok: true,
      value: 42,
    });
  });

  it("captures status, content-type and body excerpt when a non-ok response is not JSON", async () => {
    stubFetch(
      new Response("<html><body>504 Gateway Time-out</body></html>", {
        status: 504,
        statusText: "Gateway Timeout",
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );

    const error = await postJson("/api/generate", { prompt: "x" }).catch((caught) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(504);
    // Message stays the stable, user-facing sentence...
    expect((error as ApiError).message).toBe("The server returned an unexpected response. Please try again.");
    // ...while technicalDetails carries the diagnostic that pinpoints the layer.
    const details = (error as ApiError).technicalDetails ?? "";
    expect(details).toContain("HTTP 504 Gateway Timeout");
    expect(details).toContain("Content-Type: text/html; charset=utf-8");
    expect(details).toContain("Response URL:");
    expect(details).toContain("504 Gateway Time-out");
  });

  it("throws an ApiError with diagnostics for an ok response that is not JSON", async () => {
    stubFetch(
      new Response("<!DOCTYPE html><html>runtime error page</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );

    const error = await postJson("/api/generate", {}).catch((caught) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toBe("The server returned an unexpected response. Please try again.");
    expect((error as ApiError).technicalDetails).toContain("HTTP 200");
    expect((error as ApiError).technicalDetails).toContain("runtime error page");
  });

  it("surfaces a JSON error payload (message + technicalDetails) on a non-ok JSON response", async () => {
    stubFetch(
      new Response(JSON.stringify({ error: "Upstream failed", technicalDetails: "cause: timeout" }), {
        status: 502,
      }),
    );

    const error = await postJson("/api/generate", {}).catch((caught) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(502);
    expect((error as ApiError).message).toBe("Upstream failed");
    expect((error as ApiError).technicalDetails).toBe("cause: timeout");
  });
});

describe("postForm", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the FormData without overriding the multipart Content-Type", async () => {
    const fetchMock = stubFetch(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const formData = new FormData();
    formData.append("payload", "{}");

    await expect(postForm<{ ok: boolean }>("/api/bugs/post", formData)).resolves.toEqual({ ok: true });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.body).toBe(formData);
    expect(init.headers).toBeUndefined();
  });

  it("captures the diagnostic when a multipart POST returns a non-JSON error", async () => {
    stubFetch(
      new Response("502 Bad Gateway", {
        status: 502,
        statusText: "Bad Gateway",
        headers: { "content-type": "text/plain" },
      }),
    );

    const error = await postForm("/api/bugs/post", new FormData()).catch((caught) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(502);
    expect((error as ApiError).technicalDetails).toContain("HTTP 502 Bad Gateway");
  });
});

describe("nonJsonResponseDetails", () => {
  it("reports an empty body explicitly", () => {
    const details = nonJsonResponseDetails(new Response("   ", { status: 500 }), "   ");
    expect(details).toContain("(empty response body)");
  });

  it("truncates the body excerpt to 1200 characters with a truncation marker", () => {
    const long = "A".repeat(5000);
    const details = nonJsonResponseDetails(new Response(long, { status: 500 }), long);
    const excerpt = details.split("Body excerpt:\n")[1] ?? "";
    expect(excerpt.startsWith("A".repeat(1200))).toBe(true);
    expect(excerpt).toContain("truncated, 3800 more characters");
  });
});
