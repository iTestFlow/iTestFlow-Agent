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

/**
 * The only dependency types that form a specificity hierarchy. All other
 * canonical types (API, event, named-subject, and pass-through labels) retain
 * their transport/subject meaning and therefore do not collapse into one
 * another. A generic dependency is intentionally compatible with every type:
 * it carries no competing transport assertion and may be upgraded safely.
 */
const DEPENDENCY_TYPE_HIERARCHY_RANK: Readonly<Record<string, number>> = {
  dependency: 0,
  "service dependency": 1,
  "external service dependency": 2,
};

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
 * Used only as a content-equivalent-evidence fallback (terminal punctuation,
 * wrapping quotes, and case drift tolerated by the caller's comparator).
 * Removing relationship verbs lets "payment gateway call" and "payment gateway
 * dependency" match without treating unrelated labels such as "API" and
 * "event" as synonyms.
 */
export function projectKnowledgeDependencyTypeSubject(value: string) {
  return normalizeProjectKnowledgeDependencyType(value)
    .split(" ")
    .filter((token) => !TYPE_SUBJECT_STOP_WORDS.has(token))
    .join(" ");
}

/**
 * Returns whether two labels can represent the same dependency at different
 * levels of specificity. This deliberately does not make API, event, named
 * subject, or pass-through labels interchangeable with each other.
 */
export function areProjectKnowledgeDependencyTypesHierarchyCompatible(
  first: string,
  second: string,
) {
  const firstCanonical = canonicalizeProjectKnowledgeDependencyType(first);
  const secondCanonical = canonicalizeProjectKnowledgeDependencyType(second);
  if (firstCanonical === secondCanonical) return true;

  // An unqualified dependency may safely be refined to any more informative
  // type, including an API/event/named-subject/pass-through type.
  if (firstCanonical === "dependency" || secondCanonical === "dependency") return true;

  return hasDependencyTypeHierarchyRank(firstCanonical) &&
    hasDependencyTypeHierarchyRank(secondCanonical);
}

/**
 * Chooses the canonical, most-specific representation for a compatible pair.
 * Callers should only pass hierarchy-compatible labels. The lexical fallback
 * keeps this helper deterministic even if it is called defensively for an
 * incompatible pair.
 */
export function mostSpecificProjectKnowledgeDependencyType(first: string, second: string) {
  const firstCanonical = canonicalizeProjectKnowledgeDependencyType(first);
  const secondCanonical = canonicalizeProjectKnowledgeDependencyType(second);
  if (firstCanonical === secondCanonical) return firstCanonical;
  if (firstCanonical === "dependency") return secondCanonical;
  if (secondCanonical === "dependency") return firstCanonical;

  const firstRank = DEPENDENCY_TYPE_HIERARCHY_RANK[firstCanonical];
  const secondRank = DEPENDENCY_TYPE_HIERARCHY_RANK[secondCanonical];
  if (firstRank !== undefined && secondRank !== undefined) {
    return firstRank >= secondRank ? firstCanonical : secondCanonical;
  }

  return firstCanonical <= secondCanonical ? firstCanonical : secondCanonical;
}

function hasDependencyTypeHierarchyRank(value: string) {
  return Object.prototype.hasOwnProperty.call(DEPENDENCY_TYPE_HIERARCHY_RANK, value);
}

// The identicalEvidence option means both dependencies cite content-equivalent
// non-empty evidence (the caller's relaxed comparator), which licenses the
// hierarchy and shared-subject fallbacks below.
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
  if (areProjectKnowledgeDependencyTypesHierarchyCompatible(first, second)) return true;
  const firstSubject = projectKnowledgeDependencyTypeSubject(first);
  const secondSubject = projectKnowledgeDependencyTypeSubject(second);
  return Boolean(firstSubject && firstSubject === secondSubject);
}
