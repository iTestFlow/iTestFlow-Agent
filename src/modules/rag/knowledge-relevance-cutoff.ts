import type { OntologyCategory } from "./knowledge-ontology";
import { ontologyEntryId } from "./knowledge-ontology";

/**
 * Decides which compiled knowledge entries are worth sending for a given work item.
 *
 * Two independent reasons to keep an entry, because they catch different things:
 *
 * 1. **It stands out semantically.** Measured against the whole knowledge base's own
 *    similarity spread, not each category's. Per-category bars were tried and are the
 *    wrong instrument: they are relative to a category, so a category with nothing to
 *    say about the work item still promotes its own least-bad member. Measured on a real
 *    board, the two module dependencies it had were unrelated to the work item under
 *    analysis and still ranked 1st and 2nd of their category, so both were sent as
 *    though relevant. Against the global spread they are simply low.
 *
 * 2. **It is connected.** The project's own ontology says the entry belongs to the work
 *    item's module, was extracted from it or something it links to, or sits along a
 *    dependency chain from it. This is what rescues genuinely relevant knowledge that
 *    reads nothing like the work item — and it is the only signal that adapts to a board
 *    whose modules depend on each other in ways no wording reveals.
 *
 * The second is not a tiebreak. On a measured work item, the module the item belongs to
 * scored just under the global bar — 0.710 against 0.724 — so similarity alone dropped
 * the one module that mattered while keeping rules from unrelated parts of the board.
 *
 * No threshold here is tuned to a corpus. The bar is a position within whatever spread
 * the project's own knowledge produces, so it travels to a board with different
 * wording, a different language, or a different embedding scale.
 */

/**
 * Where the bar sits between the knowledge base's median and best similarity for this
 * work item. The midpoint: entries in the better half of what this project can offer.
 */
export const GLOBAL_SPREAD_FRACTION = 0.5;

export type ScoredEntry = {
  key: string;
  category: OntologyCategory;
  similarity: number;
};

export type RelevanceSelection = Partial<Record<OntologyCategory, string[]>>;

/**
 * Returns the entry keys worth sending per category, best first.
 *
 * `connected` maps ontology entry ids to hop distance; entries it contains are kept
 * regardless of similarity, and rank ahead of unconnected ones at equal similarity.
 *
 * Every category that was scored gets a key, even when nothing survived: a present
 * empty array tells the prompt renderer "this category was ranked and has nothing to
 * say — send nothing", while an absent key means "this category was never embedded —
 * keep keyword ranking". Collapsing the two into an absent key made the renderer's
 * keyword fallback re-admit exactly the entries the cutoff had rejected.
 */
export function selectRelevantEntries(
  scored: ScoredEntry[],
  connected: Map<string, number>,
): RelevanceSelection {
  if (!scored.length) return {};

  const similarities = scored.map((entry) => entry.similarity).sort((first, second) => second - first);
  const best = similarities[0];
  const median = similarities[Math.floor(similarities.length / 2)];
  const bar = median + (best - median) * GLOBAL_SPREAD_FRACTION;

  const kept = scored
    .map((entry) => ({ entry, hops: connected.get(ontologyEntryId(entry.category, entry.key)) }))
    .filter((candidate) => candidate.hops !== undefined || candidate.entry.similarity >= bar)
    // Similarity orders what connection admitted. Hop distance is a keep-or-drop signal,
    // not a ranking one: being two dependency edges away says an entry belongs in the
    // brief, but says nothing about whether it belongs above a closer, weaker match.
    .sort((first, second) => second.entry.similarity - first.entry.similarity);

  const selection: RelevanceSelection = {};
  for (const entry of scored) {
    selection[entry.category] ??= [];
  }
  for (const candidate of kept) {
    selection[candidate.entry.category]!.push(candidate.entry.key);
  }
  return selection;
}

/**
 * Whether anything survived. When nothing did, callers fall back to keyword ranking
 * rather than send an empty domain brief.
 */
export function hasAnyRelevantEntry(selected: RelevanceSelection): boolean {
  return Object.values(selected).some((keys) => keys.length > 0);
}
