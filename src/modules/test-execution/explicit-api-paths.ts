/**
 * Compile the only ad-hoc API requests the model may perform without a
 * contract operation. Requiring an explicit "METHOD /path" token in the
 * frozen step text, expected result, or execution notes prevents a vague
 * natural step from turning into endpoint guessing — for reads and writes
 * alike. Entries are "METHOD <normalized-path?sorted-query>".
 */
export const EXPLICIT_API_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const;

const EXPLICIT_REQUEST_PATTERN = /\b(GET|HEAD|POST|PUT|PATCH|DELETE)\s+((?:\/|\.\/)[^\s`"'<>]+)/gi;

export function extractExplicitApiRequests(...sources: Array<string | null | undefined>): Set<string> {
  const requests = new Set<string>();
  for (const source of sources) {
    if (!source) continue;
    for (const match of source.matchAll(EXPLICIT_REQUEST_PATTERN)) {
      const method = (match[1] as string).toUpperCase();
      const trimmed = trimTrailingPunctuation(match[2] as string);
      if (trimmed && isSafeRelativePath(trimmed)) {
        requests.add(`${method} ${normalizeRelativePath(trimmed)}`);
      }
    }
  }
  return requests;
}

/** Legacy-intent frozen runs keep the original read-only ad-hoc surface. */
export function readOnlyExplicitApiRequests(requests: ReadonlySet<string>): Set<string> {
  return new Set([...requests].filter((entry) => entry.startsWith("GET ") || entry.startsWith("HEAD ")));
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
