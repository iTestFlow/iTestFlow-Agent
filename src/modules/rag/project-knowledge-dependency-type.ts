const EVENT_MARKERS = new Set([
  "async",
  "asynchronous",
  "event",
  "events",
  "message",
  "messages",
  "messaging",
  "publish",
  "publishes",
  "queue",
  "queues",
  "subscribe",
  "subscribes",
  "webhook",
  "webhooks",
]);

const RELATION_MARKERS = new Set([
  "call",
  "called",
  "calls",
  "calling",
  "depend",
  "dependency",
  "dependent",
  "depends",
  "integrate",
  "integrates",
  "integration",
  "invoke",
  "invokes",
  "invocation",
  "require",
  "requires",
  "use",
  "uses",
  "using",
]);

const TYPE_SUBJECT_STOP_WORDS = new Set([
  ...RELATION_MARKERS,
  "a",
  "an",
  "and",
  "on",
  "the",
  "to",
]);

export function normalizeProjectKnowledgeDependencyType(value: string) {
  return value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[_/\\-]+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Converts free-form AI labels into a small stable vocabulary. This deliberately
 * preserves materially different transport semantics (for example API vs event)
 * while collapsing wording-only variants such as "external service call" and
 * "external service dependency".
 */
export function canonicalizeProjectKnowledgeDependencyType(value: string) {
  const normalized = normalizeProjectKnowledgeDependencyType(value);
  if (!normalized) return "dependency";
  const tokens = normalized.split(" ");
  const tokenSet = new Set(tokens);

  if (tokens.some((token) => EVENT_MARKERS.has(token))) return "event dependency";

  const thirdParty = tokenSet.has("external") ||
    tokenSet.has("vendor") ||
    (tokenSet.has("third") && tokenSet.has("party"));
  const relation = tokens.some((token) => RELATION_MARKERS.has(token));
  const externalSubject = tokenSet.has("service") ||
    tokenSet.has("api") ||
    tokenSet.has("gateway") ||
    tokenSet.has("integration") ||
    tokenSet.has("provider") ||
    tokenSet.has("system");
  if (thirdParty && (externalSubject || relation)) return "external service dependency";

  if (tokenSet.has("api") || tokenSet.has("rest") || tokenSet.has("graphql") || tokenSet.has("http")) {
    return "api dependency";
  }
  if (tokenSet.has("service") && relation) return "service dependency";
  const subject = tokens.filter((token) => !TYPE_SUBJECT_STOP_WORDS.has(token)).join(" ");
  if (relation && subject) return `${subject} dependency`;
  if (["call", "called", "calls", "calling", "invoke", "invokes", "invocation"].some((token) => tokenSet.has(token))) {
    return "service dependency";
  }
  if (relation) return "dependency";
  return normalized;
}

/**
 * Used only as an identical-evidence fallback. Removing relationship verbs lets
 * "payment gateway call" and "payment gateway dependency" match without treating
 * unrelated labels such as "API" and "event" as synonyms.
 */
export function projectKnowledgeDependencyTypeSubject(value: string) {
  return normalizeProjectKnowledgeDependencyType(value)
    .split(" ")
    .filter((token) => !TYPE_SUBJECT_STOP_WORDS.has(token))
    .join(" ");
}

export function areProjectKnowledgeDependencyTypesEquivalent(
  first: string,
  second: string,
  options: { identicalEvidence?: boolean } = {},
) {
  if (
    canonicalizeProjectKnowledgeDependencyType(first) ===
    canonicalizeProjectKnowledgeDependencyType(second)
  ) {
    return true;
  }
  if (!options.identicalEvidence) return false;
  const firstSubject = projectKnowledgeDependencyTypeSubject(first);
  const secondSubject = projectKnowledgeDependencyTypeSubject(second);
  return Boolean(firstSubject && firstSubject === secondSubject);
}
