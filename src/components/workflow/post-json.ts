import { ApiError, type ApiErrorPayload } from "@/components/workflow/api-error";

/* --------------------------------------------------------------------------
 * Shared JSON POST helper for the AI-generation + Azure workflow clients.
 *
 * Every generation is a single blocking POST that returns the full JSON at the
 * end. When the body is NOT JSON — a proxy 502/504, a gateway-timeout page, or
 * a runtime HTML error page (the ~240s failure signature) — we preserve the
 * real HTTP status, status text, Content-Type, response URL, and a body excerpt
 * as `technicalDetails` on an `ApiError`, so the failing layer is identifiable
 * from the error UI's "Technical details" box instead of being flattened to a
 * generic "non-JSON response" string. The happy path is unchanged.
 * ------------------------------------------------------------------------ */

export async function postJson<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
    cache: "no-store",
  });
  return readJsonResponse<T>(response);
}

/**
 * Sibling of `postJson` for multipart submissions (e.g. file attachments): the
 * browser sets the multipart Content-Type/boundary from the `FormData`, so we
 * must not set it ourselves. Shares the same non-JSON diagnostic capture.
 */
export async function postForm<T>(url: string, formData: FormData, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    body: formData,
    signal,
    cache: "no-store",
  });
  return readJsonResponse<T>(response);
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  const json = parseJsonResponse(text, response);
  if (!response.ok) throw ApiError.fromResponse(json as ApiErrorPayload, response.status);
  return json as T;
}

function parseJsonResponse(text: string, response: Response) {
  try {
    return JSON.parse(text);
  } catch {
    const technicalDetails = nonJsonResponseDetails(response, text);
    if (response.ok) {
      throw new ApiError("The server returned an invalid JSON response.", {
        status: response.status,
        technicalDetails,
      });
    }
    return {
      error: "The server returned a non-JSON response. Check the server logs or runtime configuration.",
      technicalDetails,
    };
  }
}

export function nonJsonResponseDetails(response: Response, text: string) {
  const body = text.trim();
  const bodyExcerpt = body ? body.slice(0, 1200) : "(empty response body)";
  return [
    `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`,
    `Content-Type: ${response.headers.get("content-type") ?? "(none)"}`,
    `Response URL: ${response.url || "(unknown)"}`,
    `Body excerpt:\n${bodyExcerpt}`,
  ].join("\n");
}
