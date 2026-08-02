/**
 * Resolves the surface forms a project uses for the same thing to one identity.
 *
 * Compiled knowledge is extracted from work items written by many people over a long
 * period, so one module reliably arrives under several names: a singular and a plural,
 * a name with and without a trailing "Module", an abbreviation alongside its expansion,
 * and a name that rules reference while matching no module entry at all. Measured on a
 * real board, roughly one module identity in ten was fragmented this way.
 *
 * Left unresolved these are separate nodes in the relationship graph, which is the worst
 * possible outcome: rules filed under the plural are unreachable from a work item that
 * names the singular, and the traversal reports them unconnected with full confidence.
 *
 * Only transformations that are reversible in reasoning are applied automatically — an
 * English plural fold, dropping generic head words, and expanding an abbreviation that
 * is unambiguous on this board. Anything less certain, such as two names differing by a
 * word or a transposed pair of letters, is a judgement about the project's vocabulary,
 * so it is surfaced for a person to confirm in the Knowledge Hub rather than merged
 * silently. Selection has to be adaptive; it does not have to be presumptuous.
 */

/**
 * Words that describe what a thing *is* rather than which thing it is. Stripped so
 * "Billing Module" and "Billing" resolve alike.
 *
 * Kept deliberately short. Words like "page" or "portal" look generic and are not:
 * dropping them turns "Landing Page" into "Landing" and "Partner Portal" into
 * "Partner", either of which can collide with a real, different entity on some board.
 */
const GENERIC_HEAD_WORDS = new Set([
  "the", "a", "an", "module", "modules", "system", "systems", "service", "services",
]);

/**
 * Folds a regular English plural. Deliberately narrow: irregular plurals and non-English
 * content are left alone rather than mangled, because a wrong fold merges two genuinely
 * different modules and that failure is silent.
 */
export function singularize(word: string) {
  if (word.length <= 3) return word;
  if (word.endsWith("ies") && word.length > 4) return `${word.slice(0, -3)}y`;
  if (word.endsWith("sses") || word.endsWith("shes") || word.endsWith("ches")) return word.slice(0, -2);
  if (word.endsWith("ss")) return word;
  if (word.endsWith("s")) return word.slice(0, -1);
  return word;
}

/**
 * The identity two names share when they are the same entity written differently.
 * Lowercased, punctuation-normalised, generic head words dropped, each word singular.
 */
export function entityAliasKey(value: string) {
  const words = value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .filter((word) => !GENERIC_HEAD_WORDS.has(word))
    .map(singularize);
  // A name made entirely of generic words keeps them; dropping everything would merge
  // every such name into one.
  if (!words.length) return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return words.join(" ");
}

/**
 * The initials of a multi-word name: "Shipment Tracking Module" -> "st" (generic head
 * words are already gone). Returns null for names that cannot form a meaningful acronym.
 */
export function acronymOf(value: string) {
  const words = entityAliasKey(value).split(" ").filter(Boolean);
  if (words.length < 2) return null;
  return words.map((word) => word[0]).join("");
}

export type AliasIndex = {
  /** Every known name, mapped to the identity it resolves to. */
  canonicalKeyByName: Map<string, string>;
  /** The name chosen to represent each identity, for display and diagnostics. */
  displayNameByKey: Map<string, string>;
};

/**
 * Builds an alias index over a project's entity names.
 *
 * An abbreviation only resolves when the project *also* uses the expanded form, so a
 * name that merely looks like initials stays itself. Abbreviations are never invented,
 * and one that could expand two ways on the same board is left alone rather than
 * guessed — the lint reports it so the project can decide.
 *
 * The longest surface form wins as the display name: it is the one a reader can
 * interpret without knowing the project.
 */
export function buildAliasIndex(names: Iterable<string>): AliasIndex {
  const canonicalKeyByName = new Map<string, string>();
  const displayNameByKey = new Map<string, string>();
  const namesByKey = new Map<string, string[]>();

  for (const name of names) {
    const trimmed = name?.trim();
    if (!trimmed) continue;
    const key = entityAliasKey(trimmed);
    if (!key) continue;
    canonicalKeyByName.set(trimmed, key);
    const existing = namesByKey.get(key);
    if (existing) existing.push(trimmed);
    else namesByKey.set(key, [trimmed]);
  }

  // Acronyms resolve into a spelled-out name only when that name is also present.
  const keysByAcronym = new Map<string, string[]>();
  for (const key of namesByKey.keys()) {
    const acronym = acronymOf(key);
    if (!acronym) continue;
    const existing = keysByAcronym.get(acronym);
    if (existing) existing.push(key);
    else keysByAcronym.set(acronym, [key]);
  }
  for (const [key, forms] of [...namesByKey]) {
    const expansions = keysByAcronym.get(key);
    // Ambiguous acronyms are left alone: two expansions means guessing which was meant.
    if (!expansions || expansions.length !== 1) continue;
    const target = expansions[0];
    for (const name of forms) canonicalKeyByName.set(name, target);
    namesByKey.get(target)!.push(...forms);
    namesByKey.delete(key);
  }

  for (const [key, forms] of namesByKey) {
    displayNameByKey.set(key, forms.reduce((longest, name) => (name.length > longest.length ? name : longest)));
  }
  return { canonicalKeyByName, displayNameByKey };
}

/** Resolves a name through the index, falling back to its own alias key. */
export function resolveAlias(index: AliasIndex, name: string | undefined | null) {
  const trimmed = name?.trim();
  if (!trimmed) return null;
  // entityAliasKey returns "" (not null) for punctuation-only input, and `??` would
  // let that empty string leak out as a truthy-shaped alias identity.
  return index.canonicalKeyByName.get(trimmed) ?? (entityAliasKey(trimmed) || null);
}
