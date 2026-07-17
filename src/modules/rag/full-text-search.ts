import "server-only";

import type { EmbeddingProvider } from "./embedding-provider";
import { cosineSimilarity } from "./hybrid-ranking";

/**
 * Query-side synonym expansion for QA / Azure DevOps vocabulary. Prefix matching
 * already covers morphological variants (auth:* matches "authentication"), so this
 * map only lists true lexical synonyms that prefix matching cannot bridge.
 * Keys and values must be lowercase single tokens longer than 2 characters, because
 * expansion happens after tokenization and expanded terms are bound into
 * to_tsquery('simple', ...) exactly like user terms. Kept fully symmetric (every
 * value also has its own key entry) so a term's cluster is discoverable from any
 * member -- this also lets resolveDynamicSynonyms below use "is this term a key"
 * as a cheap, correct check for "already covered statically."
 */
export const QA_DOMAIN_SYNONYMS: Record<string, string[]> = {
  bug: ["defect", "issue", "ticket"],
  defect: ["bug", "issue", "ticket"],
  issue: ["bug", "defect", "ticket"],
  ticket: ["bug", "defect", "issue"],
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
  release: ["deployment", "rollout"],
  deployment: ["release", "rollout"],
  rollout: ["release", "deployment"],
  verify: ["validate"],
  validate: ["verify"],
  estimate: ["effort"],
  effort: ["estimate"],
  pipeline: ["workflow"],
  workflow: ["pipeline"],
  repro: ["reproduce"],
  reproduce: ["repro"],
  env: ["environment"],
  environment: ["env"],
  pat: ["token"],
  token: ["pat"],
  hotfix: ["patch"],
  patch: ["hotfix"],
  flaky: ["unstable"],
  unstable: ["flaky"],
  severity: ["priority"],
  priority: ["severity"],
  assignee: ["owner"],
  owner: ["assignee"],
  resolved: ["closed"],
  closed: ["resolved"],
  open: ["active"],
  active: ["open"],
  pending: ["waiting"],
  waiting: ["pending"],
  automated: ["automatic"],
  automatic: ["automated"],
  case: ["scenario"],
  scenario: ["case"],
  reviewer: ["approver"],
  approver: ["reviewer"],
  comment: ["note"],
  note: ["comment"],
  accepted: ["approved"],
  approved: ["accepted"],
  declined: ["rejected"],
  rejected: ["declined"],
  retest: ["rerun"],
  rerun: ["retest"],
  outage: ["downtime"],
  downtime: ["outage"],
  rollback: ["revert"],
  revert: ["rollback"],
};

const MAX_QUERY_TERMS = 16;

function tokenizeQuery(value: string): string[] {
  return Array.from(
    new Set(
      value
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .map((term) => term.trim())
        .filter((term) => term.length > 2),
    ),
  ).slice(0, MAX_QUERY_TERMS);
}

function collectStaticExpansions(terms: string[], seen: Set<string>): string[] {
  return terms.flatMap((term) =>
    (QA_DOMAIN_SYNONYMS[term] ?? []).filter((synonym) => {
      if (seen.has(synonym)) return false;
      seen.add(synonym);
      return true;
    }),
  );
}

/**
 * Builds a PostgreSQL to_tsquery string from free text: lowercased alphanumeric
 * terms (>2 chars, deduped, max 16) become prefix matches joined with OR, e.g.
 * "login flow" -> "login:* | flow:* | signin:*". Terms are alphanumeric-only by
 * construction, so they are safe to bind into to_tsquery('simple', ...).
 * Known domain synonyms are appended after the user's own terms and never count
 * against the term cap, so expansion cannot displace an explicit query term.
 * Static-only and synchronous -- see buildFtsQueryWithDynamicSynonyms for a variant
 * that also consults an embedding model for terms this dictionary doesn't cover.
 */
export function buildFtsQuery(value: string): string {
  const terms = tokenizeQuery(value);
  const seen = new Set(terms);
  const expansions = collectStaticExpansions(terms, seen);
  return [...terms, ...expansions].map((term) => `${term}:*`).join(" | ");
}

// --- Dynamic (embedding-based) synonym resolution ---
//
// The static dictionary above is small and reviewable by design, but it can only
// ever cover terms someone thought to add. For a query term with no direct entry,
// use the already-configured embedding model (the same one semantic search uses)
// to find which known vocabulary term it's closest to, and borrow that term's
// synonym cluster. This is strictly additive and optional: with no embedding
// provider configured, or if the model call fails, callers fall back to
// buildFtsQuery's static-only behavior -- dynamic resolution is never a hard
// dependency for search to work.

// Every term that appears anywhere in QA_DOMAIN_SYNONYMS (as a key or a value),
// deduped. This is the fixed comparison vocabulary for dynamic resolution: a query
// term is matched against these, not against arbitrary free text, so an unexpected
// or low-confidence embedding match can't inject an unreviewed word into the query.
const DOMAIN_VOCABULARY = Array.from(
  new Set(Object.entries(QA_DOMAIN_SYNONYMS).flatMap(([term, synonyms]) => [term, ...synonyms])),
);

// Cosine similarity floor for accepting a dynamic match. Deliberately conservative:
// this is a starting point, not a calibrated value (calibrating it properly needs
// real query logs against the configured model), and it's cheaper to miss a
// borderline synonym than to silently pull an unrelated term into a search query.
const DYNAMIC_SYNONYM_SIMILARITY_THRESHOLD = 0.62;

// One embedding call per (provider, vocabulary) pair, not per query: the vocabulary
// is fixed at module load, so its embeddings are computed once per provider and
// reused until the provider (and therefore its vectorReference) changes.
let vocabularyEmbeddingsCache: { vectorReference: string; vectors: number[][] } | null = null;

async function getVocabularyEmbeddings(provider: EmbeddingProvider): Promise<number[][]> {
  if (vocabularyEmbeddingsCache?.vectorReference === provider.vectorReference) {
    return vocabularyEmbeddingsCache.vectors;
  }
  const vectors = await provider.embed(DOMAIN_VOCABULARY, "document");
  vocabularyEmbeddingsCache = { vectorReference: provider.vectorReference, vectors };
  return vectors;
}

/**
 * For each of `terms` that has no direct entry in QA_DOMAIN_SYNONYMS, finds the
 * closest term in the domain vocabulary via the given embedding model and, if it
 * clears the similarity threshold, returns that term's synonym cluster (including
 * the matched term itself). Terms already covered statically are skipped without
 * any embedding call. Returns {} (no embedding calls at all) when no provider is
 * given, and {} for any term on a model failure -- resolution degrades to nothing
 * found, never throws.
 */
export async function resolveDynamicSynonyms(
  terms: string[],
  provider: EmbeddingProvider | null | undefined,
): Promise<Record<string, string[]>> {
  if (!provider) return {};
  const unknownTerms = Array.from(new Set(terms.filter((term) => !QA_DOMAIN_SYNONYMS[term])));
  if (!unknownTerms.length) return {};

  let vocabularyVectors: number[][];
  let queryVectors: number[][];
  try {
    vocabularyVectors = await getVocabularyEmbeddings(provider);
    queryVectors = await provider.embed(unknownTerms, "query");
  } catch (error) {
    console.error("Dynamic synonym resolution failed; continuing with static synonyms only.", error);
    return {};
  }

  const result: Record<string, string[]> = {};
  unknownTerms.forEach((term, termIndex) => {
    const queryVector = queryVectors[termIndex];
    let bestVocabularyIndex = -1;
    let bestScore = DYNAMIC_SYNONYM_SIMILARITY_THRESHOLD;
    vocabularyVectors.forEach((vocabularyVector, vocabularyIndex) => {
      const score = cosineSimilarity(queryVector, vocabularyVector);
      if (score > bestScore) {
        bestScore = score;
        bestVocabularyIndex = vocabularyIndex;
      }
    });
    if (bestVocabularyIndex === -1) return;
    const matchedTerm = DOMAIN_VOCABULARY[bestVocabularyIndex]!;
    const cluster = [matchedTerm, ...(QA_DOMAIN_SYNONYMS[matchedTerm] ?? [])].filter((candidate) => candidate !== term);
    if (cluster.length) result[term] = cluster;
  });
  return result;
}

/**
 * Same contract as buildFtsQuery, plus dynamic synonym resolution (see
 * resolveDynamicSynonyms) via the given embedding model for terms the static
 * dictionary doesn't cover. Pass the same embedding provider already resolved for
 * semantic search so this reuses that model rather than configuring a separate one.
 */
export async function buildFtsQueryWithDynamicSynonyms(
  value: string,
  provider: EmbeddingProvider | null | undefined,
): Promise<string> {
  const terms = tokenizeQuery(value);
  if (!terms.length) return "";

  const seen = new Set(terms);
  const staticExpansions = collectStaticExpansions(terms, seen);
  const dynamicSynonyms = await resolveDynamicSynonyms(terms, provider);
  const dynamicExpansions = terms.flatMap((term) =>
    (dynamicSynonyms[term] ?? []).filter((synonym) => {
      if (seen.has(synonym)) return false;
      seen.add(synonym);
      return true;
    }),
  );

  return [...terms, ...staticExpansions, ...dynamicExpansions].map((term) => `${term}:*`).join(" | ");
}
