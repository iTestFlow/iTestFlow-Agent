import "server-only";

/**
 * Query-side synonym expansion for QA / Azure DevOps vocabulary. Prefix matching
 * already covers morphological variants (auth:* matches "authentication"), so this
 * map only lists true lexical synonyms that prefix matching cannot bridge.
 * Keys and values must be lowercase single tokens longer than 2 characters, because
 * expansion happens after tokenization and expanded terms are bound into
 * to_tsquery('simple', ...) exactly like user terms.
 */
export const QA_DOMAIN_SYNONYMS: Record<string, string[]> = {
  bug: ["defect"],
  defect: ["bug"],
  login: ["signin"],
  signin: ["login"],
  error: ["failure"],
  failure: ["error"],
  story: ["requirement"],
  requirement: ["story"],
  sprint: ["iteration"],
  iteration: ["sprint"],
  blocker: ["impediment"],
  impediment: ["blocker"],
  release: ["deployment"],
  deployment: ["release"],
  verify: ["validate"],
  validate: ["verify"],
  estimate: ["effort"],
  effort: ["estimate"],
};

const MAX_QUERY_TERMS = 16;

/**
 * Builds a PostgreSQL to_tsquery string from free text: lowercased alphanumeric
 * terms (>2 chars, deduped, max 16) become prefix matches joined with OR, e.g.
 * "login flow" -> "login:* | flow:* | signin:*". Terms are alphanumeric-only by
 * construction, so they are safe to bind into to_tsquery('simple', ...).
 * Known domain synonyms are appended after the user's own terms and never count
 * against the term cap, so expansion cannot displace an explicit query term.
 */
export function buildFtsQuery(value: string) {
  const terms = Array.from(
    new Set(
      value
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .map((term) => term.trim())
        .filter((term) => term.length > 2),
    ),
  ).slice(0, MAX_QUERY_TERMS);

  const seen = new Set(terms);
  const expansions = terms.flatMap((term) =>
    (QA_DOMAIN_SYNONYMS[term] ?? []).filter((synonym) => {
      if (seen.has(synonym)) return false;
      seen.add(synonym);
      return true;
    }),
  );

  return [...terms, ...expansions].map((term) => `${term}:*`).join(" | ");
}
