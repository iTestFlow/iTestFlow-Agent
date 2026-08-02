import { describe, expect, it } from "vitest";

import {
  acronymOf,
  buildAliasIndex,
  entityAliasKey,
  resolveAlias,
  singularize,
} from "@/modules/rag/entity-aliases";

describe("singularize", () => {
  it("folds regular plurals", () => {
    expect(singularize("orders")).toBe("order");
    expect(singularize("shipments")).toBe("shipment");
    expect(singularize("policies")).toBe("policy");
    expect(singularize("batches")).toBe("batch");
  });

  it("leaves words that only look plural", () => {
    // A wrong fold merges two genuinely different modules, and that failure is silent,
    // so the rule stays narrow.
    expect(singularize("address")).toBe("address");
    expect(singularize("status")).toBe("statu");
    expect(singularize("ops")).toBe("ops");
  });
});

describe("entityAliasKey", () => {
  it("resolves the ways one entity gets written", () => {
    const key = entityAliasKey("Shipment");

    expect(entityAliasKey("Shipments")).toBe(key);
    expect(entityAliasKey("shipment")).toBe(key);
    expect(entityAliasKey("Shipment Module")).toBe(key);
    expect(entityAliasKey(" Shipment  ")).toBe(key);
  });

  it("normalises punctuation and casing between spellings", () => {
    expect(entityAliasKey("Order / Return Request")).toBe(entityAliasKey("order return requests"));
  });

  it("keeps entities apart when they differ by a real word", () => {
    expect(entityAliasKey("Order Request")).not.toBe(entityAliasKey("Return Request"));
    expect(entityAliasKey("Billing")).not.toBe(entityAliasKey("Billing Report"));
  });

  it("does not empty a name made entirely of generic words", () => {
    // Otherwise every such name collapses to the same identity.
    expect(entityAliasKey("System")).not.toBe("");
    expect(entityAliasKey("System")).not.toBe(entityAliasKey("Service"));
  });
});

describe("acronymOf", () => {
  it("takes the initials of a multi-word name", () => {
    expect(acronymOf("Shipment Tracking")).toBe("st");
    expect(acronymOf("Shipment Tracking Module")).toBe("st");
  });

  it("returns nothing for a single word", () => {
    expect(acronymOf("Billing")).toBeNull();
  });
});

describe("buildAliasIndex", () => {
  it("collapses plural and suffixed spellings onto one identity", () => {
    const index = buildAliasIndex(["Shipment", "Shipments", "Shipment Module", "Billing"]);

    const shipment = index.canonicalKeyByName.get("Shipment");
    expect(index.canonicalKeyByName.get("Shipments")).toBe(shipment);
    expect(index.canonicalKeyByName.get("Shipment Module")).toBe(shipment);
    expect(index.canonicalKeyByName.get("Billing")).not.toBe(shipment);
  });

  it("expands an abbreviation the board also spells out", () => {
    const index = buildAliasIndex(["ST", "Shipment Tracking"]);

    expect(index.canonicalKeyByName.get("ST")).toBe(index.canonicalKeyByName.get("Shipment Tracking"));
  });

  it("leaves an abbreviation alone when it could expand two ways", () => {
    // Guessing here merges two unrelated modules. The lint reports the ambiguity so the
    // project can decide instead.
    const index = buildAliasIndex(["ST", "Shipment Tracking", "Settlement Terms"]);

    expect(index.canonicalKeyByName.get("ST")).not.toBe(index.canonicalKeyByName.get("Shipment Tracking"));
    expect(index.canonicalKeyByName.get("ST")).not.toBe(index.canonicalKeyByName.get("Settlement Terms"));
  });

  it("never invents an expansion the board does not use", () => {
    const index = buildAliasIndex(["ST", "Billing"]);

    expect(index.canonicalKeyByName.get("ST")).toBe("st");
  });

  it("picks the most readable surface form to represent an identity", () => {
    const index = buildAliasIndex(["Shipments", "Shipment Module", "Shipment"]);
    const key = index.canonicalKeyByName.get("Shipment")!;

    expect(index.displayNameByKey.get(key)).toBe("Shipment Module");
  });

  it("ignores blank and whitespace-only names", () => {
    const index = buildAliasIndex(["Billing", "", "   "]);

    expect(index.canonicalKeyByName.size).toBe(1);
  });
});

describe("resolveAlias", () => {
  it("resolves a name the index has never seen to its own identity", () => {
    // A rule can cite a module the module list does not contain; it still has to land
    // on the same node as the spellings that are known.
    const index = buildAliasIndex(["Shipment"]);

    expect(resolveAlias(index, "Shipments")).toBe(resolveAlias(index, "Shipment"));
  });

  it("returns nothing for an absent name", () => {
    const index = buildAliasIndex(["Shipment"]);

    expect(resolveAlias(index, undefined)).toBeNull();
    expect(resolveAlias(index, "  ")).toBeNull();
  });

  it("returns nothing for a punctuation-only name instead of an empty identity", () => {
    // entityAliasKey strips punctuation entirely, so "—" folds to "": two distinct
    // all-punctuation names must not silently resolve to the same empty alias key.
    const index = buildAliasIndex(["Shipment"]);

    expect(resolveAlias(index, "—")).toBeNull();
    expect(resolveAlias(index, "###")).toBeNull();
  });
});
