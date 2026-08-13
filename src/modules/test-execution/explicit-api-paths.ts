/**
 * Compile the only ad-hoc API requests the model may perform without a
 * contract operation. Without this, a vague natural step ("create the user")
 * would turn into endpoint guessing, so a request is authorized only when the
 * frozen step text, expected result, or execution notes name it.
 *
 * Two shapes count as naming it:
 *
 *  1. Adjacent — "POST /createAccount". Always unambiguous.
 *  2. Unambiguous pairing — the source names exactly ONE method and exactly
 *     ONE endpoint, in any order. This is the shape API documentation uses,
 *     and the shape testers paste:
 *
 *         service: createAccount
 *         Request Method: POST
 *
 *     Requiring exactly one of each is what keeps this from becoming
 *     guessing: two methods, or two candidate endpoints, and nothing is
 *     paired — only the adjacent matches survive.
 *
 * An endpoint candidate is deliberately narrow: a slash-prefixed path, or a
 * value the author explicitly labeled (`service:`, `endpoint:`, `path:` …).
 * Ordinary prose nouns are never candidates, so "the orders page" cannot
 * authorize /orders.
 *
 * Entries are "METHOD <normalized-path?sorted-query>".
 */

export const EXPLICIT_API_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const;

/** METHOD immediately followed by a relative path. Case-insensitive: the path proves intent. */
const ADJACENT_REQUEST_PATTERN = /\b(GET|HEAD|POST|PUT|PATCH|DELETE)\s+((?:\/|\.\/)[^\s`"'<>]+)/gi;

/**
 * A standalone method mention such as "Request Method: POST". Deliberately
 * UPPERCASE-only: documentation writes methods in caps, while prose writes
 * "get the order" — which must never register as a GET.
 */
const METHOD_MENTION_PATTERN = /\b(GET|HEAD|POST|PUT|PATCH|DELETE)\b/g;

/** A slash-prefixed path standing on its own, never one embedded mid-word. */
const STANDALONE_PATH_PATTERN = /(?:^|[\s(])((?:\/|\.\/)[^\s`"'<>)]+)/g;

/** An endpoint the author labeled explicitly. */
const LABELED_ENDPOINT_PATTERN =
  /\b(?:api\s+url|url|uri|endpoint|service|path|route)\s*[:=]\s*([^\s`"'<>]+)/gi;

export function extractExplicitApiRequests(input: {
  sources: Array<string | null | undefined>;
  /** Configured API base URL; lets a same-origin absolute URL resolve to its path. */
  apiBaseUrl?: string | null;
}): Set<string> {
  const requests = new Set<string>();
  for (const source of input.sources) {
    if (!source) continue;

    for (const match of source.matchAll(ADJACENT_REQUEST_PATTERN)) {
      const method = (match[1] as string).toUpperCase();
      const path = normalizeCandidate(match[2] as string, input.apiBaseUrl);
      if (path) requests.add(`${method} ${path}`);
    }

    const methods = [...new Set([...source.matchAll(METHOD_MENTION_PATTERN)].map((m) => m[1] as string))];
    if (methods.length !== 1) continue;
    const endpoints = endpointCandidates(source, input.apiBaseUrl);
    if (endpoints.length !== 1) continue;
    requests.add(`${methods[0]} ${endpoints[0]}`);
  }
  return requests;
}

/** Legacy-intent frozen runs keep the original read-only ad-hoc surface. */
export function readOnlyExplicitApiRequests(requests: ReadonlySet<string>): Set<string> {
  return new Set([...requests].filter((entry) => entry.startsWith("GET ") || entry.startsWith("HEAD ")));
}

function endpointCandidates(source: string, apiBaseUrl: string | null | undefined): string[] {
  const candidates = new Set<string>();
  for (const match of source.matchAll(STANDALONE_PATH_PATTERN)) {
    const path = normalizeCandidate(match[1] as string, apiBaseUrl);
    if (path) candidates.add(path);
  }
  for (const match of source.matchAll(LABELED_ENDPOINT_PATTERN)) {
    // A labeled value may omit the leading slash ("service: createAccount").
    const path = normalizeCandidate(match[1] as string, apiBaseUrl, { allowBareSegment: true });
    if (path) candidates.add(path);
  }
  return [...candidates];
}

/**
 * Reduce a candidate to a relative path, or null when it cannot be trusted.
 * An absolute URL resolves only when it is on the configured API origin —
 * a foreign origin is ignored rather than silently re-pointed at your own API.
 */
function normalizeCandidate(
  raw: string,
  apiBaseUrl: string | null | undefined,
  options: { allowBareSegment?: boolean } = {},
): string | null {
  const value = trimTrailingPunctuation(raw);
  if (!value) return null;

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    if (!apiBaseUrl) return null;
    try {
      const target = new URL(value);
      if (target.origin !== new URL(apiBaseUrl).origin) return null;
      return `${target.pathname}${target.search}`;
    } catch {
      return null;
    }
  }

  const relative = value.startsWith("/") || value.startsWith("./")
    ? value
    : options.allowBareSegment
      ? `/${value}`
      : null;
  if (!relative || !isSafeRelativePath(relative)) return null;
  return normalizeRelativePath(relative);
}

function trimTrailingPunctuation(value: string) {
  return value.replace(/[),.;:\]}]+$/g, "");
}

function isSafeRelativePath(value: string) {
  if (value.startsWith("//")) return false;
  try {
    return new URL(value, "https://configured.invalid/").origin === "https://configured.invalid";
  } catch {
    return false;
  }
}

function normalizeRelativePath(value: string) {
  const url = new URL(value, "https://configured.invalid/");
  return `${url.pathname}${url.search}`;
}
