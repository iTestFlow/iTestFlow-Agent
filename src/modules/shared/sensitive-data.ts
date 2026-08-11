/**
 * Single source of truth for sensitive key/column/header classification and
 * structural redaction across test execution, integrations, and LLM logging.
 *
 * Matching is anchored on normalized key-word suffixes rather than raw
 * substrings: `accessToken`, `x-api-key`, and `pass_hash` classify as
 * sensitive while `tokenCount`, `sessionTimeout`, and `cookieBannerEnabled`
 * stay readable. Redaction of persisted values happens in three layers:
 * key-based (here), exact scalar-value based (here), and substring scrubbing
 * (integrations/browser-automation/output-scrubber).
 */

/** Keys whose final normalized word alone marks the value sensitive. */
const SENSITIVE_SUFFIX_WORDS = new Set([
  "token",
  "secret", "secrets",
  "password", "passwords", "passwd", "pwd",
  "credential", "credentials",
  "authorization",
  "cookie", "cookies",
  "ssn",
  "otp",
  "pat",
]);

/** Multi-word suffixes whose last word alone would be too generic ("key", "id"). */
const SENSITIVE_SUFFIX_PHRASES: readonly (readonly string[])[] = [
  ["api", "key"],
  ["api", "keys"],
  ["private", "key"],
  ["session", "id"],
  ["session", "token"],
  ["pass", "hash"],
  ["password", "hash"],
  ["set", "cookie"],
];

/**
 * Whole keys that are sensitive despite their single word being generic in
 * compounds. "tokens" is exact-only so LLM usage stats (`totalTokens`,
 * `inputTokens`) stay readable while a bare `tokens` collection redacts.
 */
const SENSITIVE_EXACT_KEYS = new Set(["session", "tokens"]);

/**
 * Headers a stored operation or agent request may never set: they are
 * environment-owned (auth), transport-owned, or classic smuggling vectors.
 */
export const FORBIDDEN_REQUEST_HEADER =
  /^(authorization|cookie|host|content-length|connection|transfer-encoding|upgrade|proxy-|forwarded$|x-forwarded-|x-http-method-override$|x-method-override$|x-original-url$|x-rewrite-url$)/i;

export function isForbiddenRequestHeader(name: string): boolean {
  return FORBIDDEN_REQUEST_HEADER.test(name.trim());
}

/** Split a key/column/header name into normalized lowercase words. */
function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function isSensitiveKey(key: string): boolean {
  const words = keyWords(key);
  if (words.length === 0) return false;
  if (SENSITIVE_SUFFIX_WORDS.has(words[words.length - 1])) return true;
  for (const phrase of SENSITIVE_SUFFIX_PHRASES) {
    if (
      words.length >= phrase.length &&
      phrase.every((word, index) => words[words.length - phrase.length + index] === word)
    ) {
      return true;
    }
  }
  return words.length === 1 && SENSITIVE_EXACT_KEYS.has(words[0]);
}

const DEFAULT_REDACTION_DEPTH = 12;

/**
 * Replace every value stored under a sensitive-named key, at any depth.
 * The marker defaults to "<redacted>"; callers with persisted/test contracts
 * on "[REDACTED]" pass it explicitly.
 */
export function redactSensitiveKeysDeep(
  value: unknown,
  marker: string = "<redacted>",
  depth = 0,
): unknown {
  if (depth > DEFAULT_REDACTION_DEPTH) return "<truncated>";
  if (Array.isArray(value)) return value.map((entry) => redactSensitiveKeysDeep(entry, marker, depth + 1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key,
      isSensitiveKey(key) ? marker : redactSensitiveKeysDeep(child, marker, depth + 1),
    ]),
  );
}

/**
 * Collect the canonical string form of every scalar that sits under a
 * sensitive-named key (recursively — everything below a sensitive key is
 * sensitive). Used to classify captures whose value aliases a sensitive field
 * elsewhere in the same document, and to feed exact scalar-value redaction.
 * Booleans are excluded: treating `true` as a secret would redact every
 * boolean in every payload.
 */
export function collectSensitiveValues(document: unknown): Set<string> {
  const values = new Set<string>();
  collectValues(document, false, values, 0);
  return values;
}

function collectValues(value: unknown, underSensitiveKey: boolean, into: Set<string>, depth: number): void {
  if (depth > 32 || value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const entry of value) collectValues(entry, underSensitiveKey, into, depth + 1);
    return;
  }
  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      collectValues(child, underSensitiveKey || isSensitiveKey(key), into, depth + 1);
    }
    return;
  }
  if (!underSensitiveKey) return;
  if (typeof value === "string" && value.length > 0) into.add(value);
  else if (typeof value === "number" && Number.isFinite(value)) into.add(String(value));
}

/**
 * Exact scalar-value redaction: replace whole scalars equal to a known
 * sensitive value. Unlike substring scrubbing this can never corrupt JSON or
 * poison free text, so it applies to string scalars of ANY length (including
 * 1–3 character secrets that substring scrubbing must skip). Numeric scalars
 * participate only when their string form is >= 4 chars — exact-matching a
 * secret "1" would redact every ordinary count/id in the payload. Booleans
 * never participate for the same reason.
 */
export function redactExactValuesDeep<T>(
  value: T,
  sensitiveValues: ReadonlySet<string>,
  marker: string = "<redacted>",
  depth = 0,
): T {
  if (sensitiveValues.size === 0 || depth > 32) return value;
  if (typeof value === "string") {
    return (sensitiveValues.has(value) ? marker : value) as unknown as T;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const text = String(value);
    return (text.length >= 4 && sensitiveValues.has(text) ? marker : value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactExactValuesDeep(entry, sensitiveValues, marker, depth + 1)) as unknown as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        redactExactValuesDeep(entry, sensitiveValues, marker, depth + 1),
      ]),
    ) as unknown as T;
  }
  return value;
}
