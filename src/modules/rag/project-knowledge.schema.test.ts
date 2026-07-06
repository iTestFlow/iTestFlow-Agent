import { describe, expect, it } from "vitest";

import {
  ProjectKnowledgeBaseSchema,
  ProjectKnowledgeGlossaryTermSchema,
  ProjectKnowledgeModuleSchema,
} from "./project-knowledge.schema";

const glossaryEntry = (overrides: Record<string, unknown>) => ({
  term: "Cart",
  type: "term",
  definition: "A cart",
  sourceWorkItemIds: ["1"],
  evidence: "WI 1",
  ...overrides,
});

const parseGlossary = (glossary: unknown[]) => ProjectKnowledgeBaseSchema.parse({ glossary }).glossary;

describe("glossary deduplication", () => {
  it("keeps the most business-like type and merges source IDs and evidence across duplicates", () => {
    const glossary = parseGlossary([
      // Same term modulo case/whitespace; types span the preference order.
      glossaryEntry({ term: "Shopping Cart", type: "term", definition: "Basic cart", sourceWorkItemIds: ["1", "2"], evidence: "Seen in WI 1 | Seen in WI 2" }),
      glossaryEntry({ term: "shopping  cart", type: "system", definition: "Cart subsystem", sourceWorkItemIds: ["2", "3"], evidence: "Seen in WI 2 | Seen in WI 3" }),
      glossaryEntry({ term: "SHOPPING CART", type: "business_entity", definition: "The customer's cart", sourceWorkItemIds: ["4"], evidence: "Seen in WI 4" }),
      // Distinct term stays separate.
      glossaryEntry({ term: "Order", type: "business_entity", definition: "An order", sourceWorkItemIds: ["5"], evidence: "WI 5" }),
    ]);

    expect(glossary).toEqual([
      {
        // business_entity outranks system and term; the winner keeps its own term/definition.
        term: "SHOPPING CART",
        type: "business_entity",
        definition: "The customer's cart",
        // IDs and evidence merge across all duplicates in first-seen order, deduped.
        sourceWorkItemIds: ["1", "2", "3", "4"],
        evidence: "Seen in WI 1 | Seen in WI 2 | Seen in WI 3 | Seen in WI 4",
      },
      { term: "Order", type: "business_entity", definition: "An order", sourceWorkItemIds: ["5"], evidence: "WI 5" },
    ]);
  });

  it("breaks type ties by longer definition but never lets definition length outrank type", () => {
    const glossary = parseGlossary([
      glossaryEntry({ term: "Refund", type: "process", definition: "Short", sourceWorkItemIds: ["1"], evidence: "A" }),
      glossaryEntry({ term: "refund", type: "process", definition: "A longer refund process definition", sourceWorkItemIds: ["2"], evidence: "B" }),
      // Lower-priority type loses despite the longest definition.
      glossaryEntry({ term: "REFUND", type: "term", definition: "An even longer definition that must not win on length alone", sourceWorkItemIds: ["3"], evidence: "C" }),
    ]);

    expect(glossary).toEqual([
      {
        term: "refund",
        type: "process",
        definition: "A longer refund process definition",
        sourceWorkItemIds: ["1", "2", "3"],
        evidence: "A | B | C",
      },
    ]);
  });
});

describe("glossary type normalization", () => {
  const parseType = (type: unknown) =>
    ProjectKnowledgeGlossaryTermSchema.parse(glossaryEntry({ type })).type;

  it("normalizes case, whitespace, and dashes to enum values", () => {
    expect(parseType("Business Entity")).toBe("business_entity");
    expect(parseType("  external-service ")).toBe("external_service");
    // Consecutive spaces and dashes collapse into a single underscore.
    expect(parseType("Data - Entity")).toBe("data_entity");
    expect(parseType("PROCESS")).toBe("process");
  });

  it("falls back to 'term' for unknown, missing, and non-string values", () => {
    expect(parseType("widget")).toBe("term");
    expect(parseType(undefined)).toBe("term");
    expect(parseType(42)).toBe("term");
  });
});

describe("cross-dependency endpoint canonicalization", () => {
  const parseDependencies = (crossDependencies: unknown[]) => {
    const knowledgeBase = ProjectKnowledgeBaseSchema.parse({
      modules: [
        { id: "mod-1", name: "Checkout", sourceWorkItemIds: ["1"], evidence: "WI 1" },
        { id: "mod-2", name: "Payments", sourceWorkItemIds: ["2"], evidence: "WI 2" },
      ],
      glossary: [
        glossaryEntry({ term: "Order Lifecycle", type: "process", definition: "Order flow", sourceWorkItemIds: ["3"], evidence: "WI 3" }),
      ],
      crossDependencies,
    });
    return new Map(knowledgeBase.crossDependencies.map((dependency) => [dependency.id, dependency]));
  };

  const dependency = (overrides: Record<string, unknown>) => ({
    id: "dep-1",
    sourceModule: "Checkout",
    targetModule: "Payments",
    dependencyType: "calls",
    description: "desc",
    sourceWorkItemIds: ["9"],
    evidence: "WI 9",
    ...overrides,
  });

  it("rewrites exact matches to canonical casing without annotating the description", () => {
    const deps = parseDependencies([
      dependency({ id: "dep-exact", sourceModule: "  checkout ", targetModule: "PAYMENTS", description: "Checkout calls payments" }),
    ]);

    expect(deps.get("dep-exact")).toMatchObject({
      sourceModule: "Checkout",
      targetModule: "Payments",
      description: "Checkout calls payments",
    });
  });

  it("maps 'X Step N' suffix forms to the parent endpoint and records the original", () => {
    const deps = parseDependencies([
      // description omitted -> falls back to evidence before the note is appended.
      dependency({ id: "dep-step", sourceModule: "Checkout Step 3", description: undefined, evidence: "Handoff after step three" }),
    ]);

    expect(deps.get("dep-step")).toMatchObject({
      sourceModule: "Checkout",
      targetModule: "Payments",
      description: "Handoff after step three\n\nOriginal source endpoint: Checkout Step 3.",
    });
  });

  it("maps 'Step N: X' prefix forms to glossary-backed endpoints", () => {
    const deps = parseDependencies([
      dependency({ id: "dep-prefix", sourceModule: "Step #2: Order Lifecycle", targetModule: "Checkout", description: "Second step feeds checkout" }),
    ]);

    expect(deps.get("dep-prefix")).toMatchObject({
      sourceModule: "Order Lifecycle",
      targetModule: "Checkout",
      description: "Second step feeds checkout\n\nOriginal source endpoint: Step #2: Order Lifecycle.",
    });
  });

  it("falls back to the dependency id slug, excluding the opposite endpoint", () => {
    const deps = parseDependencies([
      // "checkout" is embedded in the dependency id; "Payments" is the opposite endpoint.
      dependency({ id: "dep-checkout-cleanup", sourceModule: "Unknown upstream", description: "Cleanup call" }),
    ]);

    expect(deps.get("dep-checkout-cleanup")).toMatchObject({
      sourceModule: "Checkout",
      targetModule: "Payments",
      description: "Cleanup call\n\nOriginal source endpoint: Unknown upstream.",
    });
  });

  it("leaves unresolvable endpoints untouched", () => {
    const deps = parseDependencies([
      dependency({ id: "dep-none", sourceModule: "Mystery Service", description: "no match" }),
    ]);

    expect(deps.get("dep-none")).toMatchObject({
      sourceModule: "Mystery Service",
      targetModule: "Payments",
      description: "no match",
    });
  });
});

describe("source work item IDs normalization", () => {
  const parseModule = (overrides: Record<string, unknown>) =>
    ProjectKnowledgeModuleSchema.parse({ id: "m", name: "M", sourceWorkItemIds: ["1"], evidence: "E", ...overrides });

  it("trims, drops blanks, and dedupes while preserving first-seen order", () => {
    expect(parseModule({ sourceWorkItemIds: ["  WI-2 ", "WI-1", "WI-2", "", "   "] }).sourceWorkItemIds)
      .toEqual(["WI-2", "WI-1"]);
  });

  it("rejects arrays that normalize to empty and non-string ids", () => {
    expect(ProjectKnowledgeModuleSchema.safeParse({ id: "m", name: "M", sourceWorkItemIds: [], evidence: "E" }).success).toBe(false);
    expect(ProjectKnowledgeModuleSchema.safeParse({ id: "m", name: "M", sourceWorkItemIds: ["   "], evidence: "E" }).success).toBe(false);
    // No numeric coercion: ids must already be strings.
    expect(ProjectKnowledgeModuleSchema.safeParse({ id: "m", name: "M", sourceWorkItemIds: [123], evidence: "E" }).success).toBe(false);
  });

  it("defaults a blank description to the evidence text", () => {
    expect(parseModule({ evidence: "From WI 7" }).description).toBe("From WI 7");
    expect(parseModule({ description: "  Trimmed  ", evidence: "From WI 7" }).description).toBe("Trimmed");
  });
});
