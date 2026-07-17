import { describe, expect, it, vi } from "vitest";

import {
  buildFtsQuery,
  buildFtsQueryWithDynamicSynonyms,
  QA_DOMAIN_SYNONYMS,
  resolveDynamicSynonyms,
} from "./full-text-search";
import type { EmbeddingProvider } from "./embedding-provider";

describe("buildFtsQuery", () => {
  it("strips punctuation, quotes, and tsquery operators down to alphanumeric prefix terms", () => {
    // Output is bound as a parameter into to_tsquery('simple', ...): operator
    // characters must act as separators, never survive into a term, or Postgres
    // rejects the query with a tsquery syntax error.
    expect(buildFtsQuery('How does the "login" flow work? (auth & session:*) | !reset <-> retry')).toBe(
      "how:* | does:* | the:* | login:* | flow:* | work:* | auth:* | session:* | reset:* | retry:* | signin:*",
    );
  });

  it("keeps unicode letters and digits as lowercased tokens", () => {
    expect(buildFtsQuery("Café MENU étape id42")).toBe("café:* | menu:* | étape:* | id42:*");
  });

  it("drops terms of 2 or fewer characters and joins survivors with OR", () => {
    expect(buildFtsQuery("go to the app db ui")).toBe("the:* | app:*");
  });

  it("dedupes repeated terms and caps user terms at 16", () => {
    expect(buildFtsQuery("Login login LOGIN")).toBe("login:* | signin:*");

    const terms = Array.from({ length: 20 }, (_, index) => `term${String(index).padStart(2, "0")}`);
    expect(buildFtsQuery(terms.join(" "))).toBe(
      terms.slice(0, 16).map((term) => `${term}:*`).join(" | "),
    );
  });

  it("returns an empty query for empty, whitespace-only, or operator-only input", () => {
    expect(buildFtsQuery("")).toBe("");
    expect(buildFtsQuery("   \t  ")).toBe("");
    expect(buildFtsQuery("?! &| :* ()")).toBe("");
    expect(buildFtsQuery("a of it")).toBe("");
  });

  it("appends domain synonyms after the user's own terms", () => {
    expect(buildFtsQuery("bug in checkout")).toBe("bug:* | checkout:* | defect:* | issue:* | ticket:*");
  });

  it("never duplicates a synonym the user already typed", () => {
    expect(buildFtsQuery("bug defect triage")).toBe("bug:* | defect:* | triage:* | issue:* | ticket:*");
  });

  it("does not let synonym expansion displace user terms from the 16-term cap", () => {
    const fillers = Array.from({ length: 15 }, (_, index) => `filler${String(index).padStart(2, "0")}`);
    const query = buildFtsQuery([...fillers, "bug"].join(" "));
    expect(query).toContain("bug:*");
    // bug's full cluster (defect, issue, ticket) appends after all 16 user terms.
    expect(query.endsWith("ticket:*")).toBe(true);
    expect(query.split(" | ")).toHaveLength(19);
  });

  it("keeps every synonym entry lowercase, longer than 2 chars, and single-token", () => {
    // The expansion contract: synonyms are bound into to_tsquery exactly like user
    // terms, so a multi-word or uppercase entry would silently produce a broken or
    // never-matching prefix term.
    for (const [term, synonyms] of Object.entries(QA_DOMAIN_SYNONYMS)) {
      for (const value of [term, ...synonyms]) {
        expect(value).toBe(value.toLowerCase());
        expect(value.length).toBeGreaterThan(2);
        expect(value).toMatch(/^[\p{L}\p{N}]+$/u);
      }
    }
  });

  it("is fully symmetric: every synonym also has its own key entry", () => {
    // resolveDynamicSynonyms treats "is this term a key" as "already covered
    // statically" for every cluster member -- that only holds if every value is
    // also its own key.
    for (const synonyms of Object.values(QA_DOMAIN_SYNONYMS)) {
      for (const synonym of synonyms) {
        expect(QA_DOMAIN_SYNONYMS[synonym]).toBeDefined();
      }
    }
  });
});

// Vectors chosen so "downtime" (a real dictionary term) and "blackout" (not in the
// dictionary) are near-identical, while every other vocabulary term gets the exact
// same orthogonal "catch-all" vector -- this keeps the test correct regardless of
// what else is in QA_DOMAIN_SYNONYMS, since no catch-all term can accidentally
// outscore the crafted match.
const DOWNTIME_VECTOR = [1, 0, 0];
const BLACKOUT_VECTOR = [0.9, 0.1, 0];
const CATCH_ALL_VECTOR = [0, 0, 1];

// Vocabulary embeddings are cached module-wide, keyed by vectorReference (see
// getVocabularyEmbeddings) -- each test's fake provider needs its own unique
// reference, or an earlier test's cached vectors leak into a later one that
// happens to reuse the same reference string.
let fakeProviderCounter = 0;

function fakeProvider(embed: EmbeddingProvider["embed"]): EmbeddingProvider {
  fakeProviderCounter += 1;
  return { name: "ollama", model: "fake-model", vectorReference: `ollama:fake-model-${fakeProviderCounter}`, embed };
}

function vectorLookupProvider() {
  const embed = vi.fn(async (texts: string[]) =>
    texts.map((text) => {
      if (text === "downtime") return DOWNTIME_VECTOR;
      if (text === "blackout") return BLACKOUT_VECTOR;
      return CATCH_ALL_VECTOR;
    }),
  );
  return { provider: fakeProvider(embed), embed };
}

describe("resolveDynamicSynonyms", () => {
  it("returns {} without calling the model when no provider is given", async () => {
    expect(await resolveDynamicSynonyms(["blackout"], null)).toEqual({});
    expect(await resolveDynamicSynonyms(["blackout"], undefined)).toEqual({});
  });

  it("skips terms already covered by the static dictionary without calling the model", async () => {
    const { provider, embed } = vectorLookupProvider();
    expect(await resolveDynamicSynonyms(["bug", "defect"], provider)).toEqual({});
    expect(embed).not.toHaveBeenCalled();
  });

  it("resolves an unknown term to its nearest vocabulary cluster above the similarity threshold", async () => {
    const { provider } = vectorLookupProvider();
    const result = await resolveDynamicSynonyms(["blackout"], provider);
    expect(result).toEqual({ blackout: ["downtime", "outage"] });
  });

  it("ignores terms whose best match is below the similarity threshold", async () => {
    // The whole vocabulary gets one fixed vector; "gibberish" gets an orthogonal
    // one (cosine similarity 0), so nothing clears the threshold.
    const provider = fakeProvider(async (texts) =>
      texts.map((text) => (text === "gibberish" ? [1, 0] : [0, 1])),
    );
    expect(await resolveDynamicSynonyms(["gibberish"], provider)).toEqual({});
  });

  it("falls back to {} when the embedding call throws", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const provider = fakeProvider(async () => {
      throw new Error("embedding backend unreachable");
    });
    expect(await resolveDynamicSynonyms(["blackout"], provider)).toEqual({});
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("caches vocabulary embeddings across calls for the same provider", async () => {
    const { provider, embed } = vectorLookupProvider();
    await resolveDynamicSynonyms(["blackout"], provider);
    const callsAfterFirst = embed.mock.calls.length;
    await resolveDynamicSynonyms(["blackout"], provider);
    // Second call only re-embeds the query term, not the whole vocabulary again.
    expect(embed.mock.calls.length).toBe(callsAfterFirst + 1);
  });
});

describe("buildFtsQueryWithDynamicSynonyms", () => {
  it("matches buildFtsQuery's static-only output when no provider is given", async () => {
    expect(await buildFtsQueryWithDynamicSynonyms("bug in checkout", null)).toBe(buildFtsQuery("bug in checkout"));
  });

  it("returns an empty query for empty input without calling the model", async () => {
    const { provider, embed } = vectorLookupProvider();
    expect(await buildFtsQueryWithDynamicSynonyms("   ", provider)).toBe("");
    expect(embed).not.toHaveBeenCalled();
  });

  it("appends dynamic expansions after static ones, without duplicating terms", async () => {
    const { provider } = vectorLookupProvider();
    const result = await buildFtsQueryWithDynamicSynonyms("blackout downtime", provider);
    // "downtime" is user-typed (and statically covered), so its static synonym
    // "outage" comes first; "blackout" has no static entry, so its dynamic match
    // ("downtime", already seen) contributes only the not-yet-seen "outage" --
    // already added, so nothing new from blackout's own resolution either.
    expect(result).toBe("blackout:* | downtime:* | outage:*");
  });
});
