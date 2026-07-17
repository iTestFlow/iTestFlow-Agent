import { describe, expect, it } from "vitest";

import { buildFtsQuery, QA_DOMAIN_SYNONYMS } from "./full-text-search";

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
    expect(buildFtsQuery("bug in checkout")).toBe("bug:* | checkout:* | defect:*");
  });

  it("never duplicates a synonym the user already typed", () => {
    expect(buildFtsQuery("bug defect triage")).toBe("bug:* | defect:* | triage:*");
  });

  it("does not let synonym expansion displace user terms from the 16-term cap", () => {
    const fillers = Array.from({ length: 15 }, (_, index) => `filler${String(index).padStart(2, "0")}`);
    const query = buildFtsQuery([...fillers, "bug"].join(" "));
    expect(query).toContain("bug:*");
    expect(query.endsWith("defect:*")).toBe(true);
    expect(query.split(" | ")).toHaveLength(17);
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
});
