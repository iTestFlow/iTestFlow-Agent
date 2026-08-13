import { describe, expect, it } from "vitest";

import { estimateTokens, usableInputTokens } from "@/modules/llm/token-estimate";
import {
  buildExistingTestCaseReviewMarkdownPrompt,
  buildRequirementAnalysisMarkdownPrompt,
  buildTestCaseGenerationMarkdownPrompt,
  cleanPromptText,
  extractWorkItemId,
} from "@/modules/llm/markdown-prompt-renderer";
import type { ProjectKnowledgeBase } from "@/modules/rag/project-knowledge.schema";

const currentProject = { azureProjectId: "azure-project-1", azureProjectName: "Demo Project" };
const outputContract = { analysis: "string", contextUsed: ["string"] };

// Chosen so the ranking query tokens are exactly:
// 101, title, checkout, description, customer, pays, with, saved, card.
const targetRequirement = { id: 101, title: "Checkout", description: "Customer pays with saved card" };

// Modules: 8 candidates against a budget of 6. m0/m1 carry the priority source (101),
// m2..m7 tie on one term hit ("checkout") so truncation must drop the last two by
// original order. Business rules: index 3 carries the priority source and must rank
// first; indexes 0-1 score zero but survive via the first-three guarantee; index 4
// scores zero beyond that window and must be dropped entirely.
function knowledgeBase(): ProjectKnowledgeBase {
  return {
    modules: [
      { id: "mod-payments", name: "Payments", description: "Handles checkout payment capture", sourceWorkItemIds: ["101"], evidence: "Checkout payment evidence" },
      { id: "mod-cart", name: "Cart", description: "Cart management before checkout", sourceWorkItemIds: ["101"], evidence: "Cart checkout evidence" },
      { id: "mod-shipping", name: "Shipping", description: "Ships orders after checkout", sourceWorkItemIds: ["502"], evidence: "Shipping note" },
      { id: "mod-returns", name: "Returns", description: "Handles returns after checkout", sourceWorkItemIds: ["503"], evidence: "Returns note" },
      { id: "mod-invoicing", name: "Invoicing", description: "Invoices are issued after checkout", sourceWorkItemIds: ["504"], evidence: "Invoicing note" },
      { id: "mod-catalog", name: "Catalog", description: "Product catalog browsed before checkout", sourceWorkItemIds: ["505"], evidence: "Catalog note" },
      { id: "mod-search", name: "Search", description: "Search precedes checkout", sourceWorkItemIds: ["506"], evidence: "Search note" },
      { id: "mod-profile", name: "Profile", description: "Profile screens near checkout", sourceWorkItemIds: ["507"], evidence: "Profile note" },
    ],
    businessRules: [
      { id: "loyalty-round", rule: "Loyalty points round down to the nearest whole point", sourceField: "metadata", moduleName: "Loyalty", sourceWorkItemIds: ["610"], evidence: "Loyalty rounding note" },
      { id: "stock-hold", rule: "Held stock is released after two hours", sourceField: "metadata", moduleName: "Inventory", sourceWorkItemIds: ["611"], evidence: "Stock hold note" },
      { id: "cod-limit", rule: "Checkout blocks cash on delivery for orders above 5000", sourceField: "description", moduleName: "Payments", sourceWorkItemIds: ["620"], evidence: "Cash on delivery limit note" },
      { id: "card-verify", rule: "Saved card payments require CVV confirmation at checkout", sourceField: "acceptanceCriteria", moduleName: "Payments", sourceWorkItemIds: ["101"], evidence: "Saved card CVV note" },
      { id: "gift-wrap", rule: "Gift wrapping adds a flat fee per order", sourceField: "metadata", moduleName: "Fulfillment", sourceWorkItemIds: ["612"], evidence: "Gift wrap fee note" },
    ],
    stateTransitions: [
      { id: "st-checkout", workflowName: "Checkout", fromState: "Cart", toState: "Paid", triggerOrCondition: "Payment captured", actor: "Customer", moduleName: "Payments", sourceWorkItemIds: ["101"], evidence: "Order state note" },
    ],
    glossary: [
      { term: "OTP", type: "term", definition: "One-time password used to confirm checkout payment", sourceWorkItemIds: ["101"], evidence: "OTP evidence" },
    ],
    crossDependencies: [
      { id: "dep-pay-notify", sourceModule: "Payments", targetModule: "Notifications", dependencyType: "event", description: "Payment success triggers a customer notification", sourceWorkItemIds: ["101"], evidence: "Dependency evidence" },
    ],
    chatInsights: [],
  };
}

function expectOrdered(prompt: string, markers: string[]) {
  const positions = markers.map((marker) => prompt.indexOf(marker));
  positions.forEach((position, index) => {
    expect(position, `missing marker: ${markers[index]}`).toBeGreaterThanOrEqual(0);
  });
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
}

describe("cleanPromptText", () => {
  it("converts nested Azure DevOps lists, paragraphs, bold, and entities to markdown", () => {
    const html =
      "<div><p>The customer <b>must</b> be signed&nbsp;in.</p><p>Rules:</p>" +
      "<ul><li>Cart total &gt; 100&nbsp;EGP</li><li>Saved cards:<ol><li>Visa</li><li>Mastercard</li></ol></li></ul></div>";
    expect(cleanPromptText(html)).toBe(
      "The customer **must** be signed in.\n\nRules:\n\n- Cart total > 100 EGP\n- Saved cards:\n- Visa\n- Mastercard",
    );
  });

  it("flattens tables to pipe-joined cells; adjacent body rows collapse onto one line", () => {
    const html =
      "<table><thead><tr><th>Field</th><th>Limit</th></tr></thead>" +
      "<tbody><tr><td>Name</td><td>50 chars</td></tr><tr><td>Email</td><td>254 chars</td></tr></tbody></table>";
    // The </tr><tr> row break becomes a newline that the cell join then consumes.
    expect(cleanPromptText(html)).toBe("Field | Limit\n\nName | 50 chars | Email | 254 chars");
  });

  it("collapses runs of spaces/tabs/blank lines and turns <br> into newlines", () => {
    expect(cleanPromptText("Line one   with&nbsp;&nbsp;gaps<br/>Line two\t\tend   <br><br><br>Line three")).toBe(
      "Line one with gaps\nLine two end\n\nLine three",
    );
    expect(cleanPromptText('&quot;Premium&quot; tier &amp; &#39;Gold&#39; tier &mdash; totals &gt; 100 &ndash; done')).toBe(
      "\"Premium\" tier & 'Gold' tier - totals > 100 - done",
    );
    // A lone decoded "<" is preserved because the generic tag strip needs a closing ">".
    expect(cleanPromptText("value &lt; 100")).toBe("value < 100");
  });

  it("returns undefined for missing input but empty string for whitespace-only input", () => {
    expect(cleanPromptText(undefined)).toBeUndefined();
    expect(cleanPromptText("")).toBeUndefined();
    expect(cleanPromptText("   \n  ")).toBe("");
  });
});

describe("extractWorkItemId", () => {
  it("stringifies workItemId/id/azureWorkItemId in precedence order and rejects non-scalars", () => {
    expect(extractWorkItemId({ workItemId: 7 })).toBe("7");
    expect(extractWorkItemId({ id: "abc-1" })).toBe("abc-1");
    expect(extractWorkItemId({ azureWorkItemId: 33 })).toBe("33");
    expect(extractWorkItemId({ workItemId: "9", id: "1", azureWorkItemId: "2" })).toBe("9");
    // Nullish coalescing skips null workItemId but a non-scalar id wins and yields undefined.
    expect(extractWorkItemId({ workItemId: null, id: 5 })).toBe("5");
    expect(extractWorkItemId({ id: { nested: true }, azureWorkItemId: 3 })).toBeUndefined();
    expect(extractWorkItemId("55")).toBeUndefined();
    expect(extractWorkItemId(null)).toBeUndefined();
    expect(extractWorkItemId(42)).toBeUndefined();
  });
});

describe("buildRequirementAnalysisMarkdownPrompt", () => {
  it("inserts the raw-authority notice before saved knowledge in every shared workflow", () => {
    const projectKnowledgeNotice = "Current raw work-item evidence wins every conflict.";
    const inputs = { currentProject, targetRequirement, outputContract, projectKnowledgeNotice };
    const prompts = [
      buildRequirementAnalysisMarkdownPrompt(inputs).prompt,
      buildTestCaseGenerationMarkdownPrompt(inputs).prompt,
      buildExistingTestCaseReviewMarkdownPrompt(inputs).prompt,
    ];

    for (const prompt of prompts) {
      expectOrdered(prompt, ["# Knowledge Authority", projectKnowledgeNotice, "# Saved Project Knowledge"]);
    }
  });

  it("renders sections in a fixed order with the output contract JSON last", () => {
    const { prompt, relevantProjectKnowledgeBase } = buildRequirementAnalysisMarkdownPrompt({
      currentProject,
      targetRequirement,
      outputContract,
    });

    expect(relevantProjectKnowledgeBase).toBeNull();
    expectOrdered(prompt, [
      "# Current Project",
      "# User Story Under Analysis",
      // Numeric ids are omitted from the heading (only string ids render as "#<id> - ").
      "## Checkout",
      "# Related Work Items",
      "# Project Context",
      "# Saved Project Knowledge",
      "# Required JSON Output",
    ]);
    expect(prompt).toContain("- Azure Project ID: azure-project-1");
    expect(prompt).toContain("- Azure Project Name: Demo Project");
    expect(prompt).toContain("Description:\nCustomer pays with saved card");
    expect(prompt).toContain("No saved project knowledge was supplied.");
    expect(prompt).toContain(JSON.stringify(outputContract, null, 2));
    // Target has no acceptance criteria and this workflow adds no test-design sections.
    expect(prompt).not.toContain("Acceptance Criteria:");
    expect(prompt).not.toContain("# Coverage Expectations");
  });

  it("ranks knowledge by priority sources and term hits, and includes it all when the window allows", () => {
    const { prompt, relevantProjectKnowledgeBase } = buildRequirementAnalysisMarkdownPrompt({
      currentProject,
      targetRequirement,
      projectKnowledgeBase: knowledgeBase(),
      outputContract,
    });

    // Selection is by token budget, not a fixed count: this fixture fits comfortably in
    // the default window, so nothing is dropped. What still matters is the ORDER —
    // priority-source items first, then original order among equal scores.
    expect(relevantProjectKnowledgeBase?.modules.slice(0, 3).map((item) => item.id)).toEqual([
      "mod-payments",
      "mod-cart",
      "mod-shipping",
    ]);
    expect(relevantProjectKnowledgeBase?.businessRules.slice(0, 2).map((item) => item.id)).toEqual([
      "card-verify",
      "cod-limit",
    ]);

    // Every knowledge section header survives selection, in order.
    expectOrdered(prompt, [
      "# Saved Project Knowledge",
      "## Modules",
      "## Business Rules",
      "## State Transitions",
      "## Glossary",
      "## Dependencies",
      "# Required JSON Output",
    ]);
    expect(prompt).toContain("- mod-payments: Payments");
    expect(prompt).toContain("  - Sources: 101");
    expect(prompt).toContain("- card-verify: Saved card payments require CVV confirmation at checkout");
    expect(prompt).toContain("  - Transition: Cart -> Paid");
    expect(prompt).toContain("- OTP (term): One-time password used to confirm checkout payment");
    expect(prompt).toContain("- dep-pay-notify: Payments -> Notifications");
  });

  it("truncates compiled knowledge to a small model's window, keeping every category represented", () => {
    // The previous hard caps (6 modules / 14 rules / …) ignored the model entirely, so a
    // 213-entry knowledge base reached workflows as a fixed 22% slice. Selection is now
    // sized to the window, with a per-category floor so nothing disappears completely.
    const generous = buildRequirementAnalysisMarkdownPrompt({
      currentProject, targetRequirement, projectKnowledgeBase: knowledgeBase(), outputContract,
      maxInputTokens: 200_000,
    }).relevantProjectKnowledgeBase;
    const tiny = buildRequirementAnalysisMarkdownPrompt({
      currentProject, targetRequirement, projectKnowledgeBase: knowledgeBase(), outputContract,
      maxInputTokens: 1_000,
    }).relevantProjectKnowledgeBase;

    expect(tiny!.modules.length).toBeLessThanOrEqual(generous!.modules.length);
    expect(tiny!.businessRules.length).toBeLessThanOrEqual(generous!.businessRules.length);
    // Floors: a narrow window must not silently erase a whole category.
    for (const category of ["modules", "businessRules", "glossary"] as const) {
      if (generous![category].length > 0) expect(tiny![category].length).toBeGreaterThan(0);
    }
    // Whatever survives is still the highest-ranked, not an arbitrary prefix.
    expect(tiny!.modules[0]!.id).toBe(generous!.modules[0]!.id);
  });

  it("keeps at least the workspace top-K related work items when the window can afford them, adding more when it allows", () => {
    const related = Array.from({ length: 30 }, (_, index) => ({
      id: String(900 + index),
      title: `Related item ${index}`,
      description: "x".repeat(50),
    }));
    const floor = 8;
    const modest = buildRequirementAnalysisMarkdownPrompt({
      currentProject, targetRequirement, relatedWorkItems: related, outputContract,
      maxInputTokens: 1_200, relatedWorkItemsFloor: floor,
    }).prompt;
    const generous = buildRequirementAnalysisMarkdownPrompt({
      currentProject, targetRequirement, relatedWorkItems: related, outputContract,
      maxInputTokens: 200_000, relatedWorkItemsFloor: floor,
    }).prompt;

    const included = (prompt: string) => related.filter((item) => prompt.includes(item.title)).length;
    // top-K is a deliberate user setting, so it is a floor once the window can afford it...
    expect(included(modest)).toBeGreaterThanOrEqual(floor);
    // ...and the budget only ever adds beyond it.
    expect(included(generous)).toBeGreaterThan(included(modest));
  });

  it("does not let the floor guarantee consume the whole window when related items are unusually large", () => {
    // Regression guard: the floor stage used to add items regardless of cost while under
    // the floor count, so a handful of large related items alone could exceed the entire
    // configured model window with nothing to stop it. This uses the same 600-character
    // items the previous version of this test forced in whole -- proving 8 of them no
    // longer fit inside a genuinely tiny window is the fix, not a regression.
    const related = Array.from({ length: 30 }, (_, index) => ({
      id: String(900 + index),
      title: `Related item ${index}`,
      description: "x".repeat(600),
    }));
    const floor = 8;
    const maxInputTokens = 1_000;
    const prompt = buildRequirementAnalysisMarkdownPrompt({
      currentProject, targetRequirement, relatedWorkItems: related, outputContract,
      maxInputTokens, relatedWorkItemsFloor: floor,
    }).prompt;

    const includedCount = related.filter((item) => prompt.includes(item.title)).length;
    expect(includedCount).toBeGreaterThan(0);
    expect(includedCount).toBeLessThan(floor);
    expect(estimateTokens(prompt)).toBeLessThanOrEqual(usableInputTokens(maxInputTokens));
  });

  it("renders context items and extra instructions only when supplied", () => {
    const bare = buildRequirementAnalysisMarkdownPrompt({
      currentProject,
      targetRequirement,
      outputContract,
    }).prompt;
    // Both Related Work Items and Project Context fall back to the empty message.
    expect(bare.split("No related items were supplied.").length - 1).toBe(2);
    expect(bare).not.toContain("Context Content:");
    expect(bare).not.toContain("## Extra Instructions");

    const withContext = buildRequirementAnalysisMarkdownPrompt({
      currentProject,
      targetRequirement,
      selectedContext: [
        {
          id: "ctx-9",
          documentName: "Payments spec",
          content: "<p>3-D Secure &amp; OTP flows</p>",
          relevanceScore: 0.87,
          metadata: { tags: ["payments"] },
        },
      ],
      extraInstructions: "Focus on payment declines.",
      outputContract,
    }).prompt;

    // Only Related Work Items is still empty.
    expect(withContext.split("No related items were supplied.").length - 1).toBe(1);
    expect(withContext).toContain("## #ctx-9 - Payments spec");
    expect(withContext).toContain("- Relevance Score: 0.87");
    expect(withContext).toContain("- Tags: payments");
    expect(withContext).toContain("Context Content:\n3-D Secure & OTP flows");
    expectOrdered(withContext, [
      "# Project Context",
      "## Extra Instructions",
      "Focus on payment declines.",
      "# Required JSON Output",
    ]);
  });
});

describe("buildTestCaseGenerationMarkdownPrompt", () => {
  it("renders normalized test design options with range, focus labels, and coverage expectations", () => {
    const { prompt } = buildTestCaseGenerationMarkdownPrompt({
      currentProject,
      targetRequirement,
      options: {
        targetTestCaseRange: "standard",
        targetTestCaseRangeLabel: "Standard (6-12 cases)",
        minCases: 6,
        maxCases: 12,
        coverageFocusIds: [],
        coverageFocusLabels: ["Positive scenarios", "Negative & error handling"],
      },
      outputContract,
    });

    expect(prompt).toContain("- Target Test Case Range: Standard (6-12 cases)");
    expect(prompt).toContain("- Target test case range: 6-12");
    expect(prompt).toContain("  - Positive scenarios");
    expect(prompt).toContain("  - Negative & error handling");
    expect(prompt).toContain("Only the Coverage Focus items listed above are selected for this run.");
    expectOrdered(prompt, [
      "# Test Design Options",
      "# Coverage Expectations",
      "# Saved Project Knowledge",
      "# Required JSON Output",
    ]);
  });

  it("falls back to key/value option lines, dropping empty values but keeping false", () => {
    const { prompt } = buildTestCaseGenerationMarkdownPrompt({
      currentProject,
      targetRequirement,
      options: { testerFocus: "mobile", riskAppetite: 3, dryRun: false, ignored: "", skipped: null },
      outputContract,
    });

    expect(prompt).toContain("- testerFocus: mobile");
    expect(prompt).toContain("- riskAppetite: 3");
    expect(prompt).toContain("- dryRun: false");
    expect(prompt).not.toContain("ignored");
    expect(prompt).not.toContain("skipped");

    const empty = buildTestCaseGenerationMarkdownPrompt({
      currentProject,
      targetRequirement,
      outputContract,
    }).prompt;
    expect(empty).toContain("No additional test design options were supplied.");
  });
});

// A corpus far larger than any single prompt can carry, shaped like a mature project:
// business rules dominate, everything else is a long tail. None of the entries mention
// the target requirement's terms, so keyword ranking cannot separate them and selection
// is decided purely by budget and weighting — which is the situation under test.
function largeKnowledgeBase(businessRuleCount: number): ProjectKnowledgeBase {
  const pad = (label: string, index: number) =>
    `${label} ${index} covering behaviour that the system must enforce consistently`;
  return {
    modules: Array.from({ length: 60 }, (_, index) => ({
      id: `mod-${index}`, name: `Module ${index}`, description: pad("Module behaviour", index),
      sourceWorkItemIds: [`${900 + index}`], evidence: `Module evidence ${index}`,
    })),
    businessRules: Array.from({ length: businessRuleCount }, (_, index) => ({
      id: `rule-${index}`, rule: pad("Business rule", index), sourceField: "description",
      moduleName: `Module ${index % 60}`, sourceWorkItemIds: [`${900 + index}`],
      evidence: `Rule evidence ${index}`,
    })),
    stateTransitions: Array.from({ length: 120 }, (_, index) => ({
      id: `st-${index}`, workflowName: `Workflow ${index}`, fromState: "Draft", toState: "Approved",
      triggerOrCondition: pad("Transition trigger", index), actor: "Reviewer",
      moduleName: `Module ${index % 60}`, sourceWorkItemIds: [`${900 + index}`],
      evidence: `Transition evidence ${index}`,
    })),
    glossary: Array.from({ length: 200 }, (_, index) => ({
      term: `Term${index}`, type: "term", definition: pad("Definition", index),
      sourceWorkItemIds: [`${900 + index}`], evidence: `Glossary evidence ${index}`,
    })),
    crossDependencies: Array.from({ length: 80 }, (_, index) => ({
      id: `dep-${index}`, sourceModule: `Module ${index % 60}`, targetModule: `Module ${(index + 1) % 60}`,
      dependencyType: "event", description: pad("Dependency", index),
      sourceWorkItemIds: [`${900 + index}`], evidence: `Dependency evidence ${index}`,
    })),
    chatInsights: [],
  };
}

function selectionFor(builder: typeof buildTestCaseGenerationMarkdownPrompt, options: {
  projectKnowledgeBase: ProjectKnowledgeBase;
  maxInputTokens: number;
  rankedKnowledgeKeys?: Record<string, string[]>;
}) {
  const result = builder({
    currentProject,
    targetRequirement,
    outputContract,
    projectKnowledgeBase: options.projectKnowledgeBase,
    maxInputTokens: options.maxInputTokens,
    rankedKnowledgeKeys: options.rankedKnowledgeKeys,
  });
  const selected = result.relevantProjectKnowledgeBase;
  return {
    modules: selected?.modules.length ?? 0,
    businessRules: selected?.businessRules.length ?? 0,
    stateTransitions: selected?.stateTransitions.length ?? 0,
    glossary: selected?.glossary.length ?? 0,
    crossDependencies: selected?.crossDependencies.length ?? 0,
    ruleIds: selected?.businessRules.map((rule) => rule.id) ?? [],
    moduleIds: selected?.modules.map((module) => module.id) ?? [],
    total: selected
      ? selected.modules.length + selected.businessRules.length + selected.stateTransitions.length
        + selected.glossary.length + selected.crossDependencies.length
      : 0,
  };
}

describe("compiled knowledge selection at corpus scale", () => {
  const knowledge = largeKnowledgeBase(1000);

  it("gives business rules and state transitions most of the room in test design", () => {
    const selection = selectionFor(buildTestCaseGenerationMarkdownPrompt, {
      projectKnowledgeBase: knowledge,
      maxInputTokens: 128_000,
    });

    // The failure this guards against is uniform round-robin, under which every
    // category takes one slot per pass and 1,000 business rules end up with roughly the
    // same count as 200 glossary terms.
    expect(selection.businessRules).toBeGreaterThan(selection.glossary * 2);
    expect(selection.businessRules).toBeGreaterThan(selection.modules * 2);
    expect(selection.stateTransitions).toBeGreaterThan(selection.glossary);
    const testConditions = selection.businessRules + selection.stateTransitions;
    expect(testConditions / selection.total).toBeGreaterThan(0.6);
  });

  it("keeps every category represented when the window allows it", () => {
    const selection = selectionFor(buildTestCaseGenerationMarkdownPrompt, {
      projectKnowledgeBase: knowledge,
      maxInputTokens: 128_000,
    });

    expect(selection.modules).toBeGreaterThan(0);
    expect(selection.glossary).toBeGreaterThan(0);
    expect(selection.crossDependencies).toBeGreaterThan(0);
  });

  it("weights the same corpus differently for requirement analysis", () => {
    // Sized so no category is saturated; at a very large window both profiles simply
    // send everything and the weighting is unobservable.
    const design = selectionFor(buildTestCaseGenerationMarkdownPrompt, {
      projectKnowledgeBase: knowledge, maxInputTokens: 16_000,
    });
    const analysis = selectionFor(buildRequirementAnalysisMarkdownPrompt, {
      projectKnowledgeBase: knowledge, maxInputTokens: 16_000,
    });

    // Analysis is about scope and impact, so structure earns more room and rules less.
    expect(analysis.modules).toBeGreaterThan(design.modules);
    expect(analysis.crossDependencies).toBeGreaterThan(design.crossDependencies);
    expect(analysis.glossary).toBeGreaterThan(design.glossary);
    expect(analysis.businessRules).toBeLessThan(design.businessRules);
  });

  it("scales what it sends with the model window", () => {
    const small = selectionFor(buildTestCaseGenerationMarkdownPrompt, {
      projectKnowledgeBase: knowledge, maxInputTokens: 16_000,
    });
    const large = selectionFor(buildTestCaseGenerationMarkdownPrompt, {
      projectKnowledgeBase: knowledge, maxInputTokens: 200_000,
    });

    expect(small.businessRules).toBeGreaterThan(0);
    expect(large.businessRules).toBeGreaterThan(small.businessRules * 3);
  });

  it("does not discard entries that share no wording with the work item", () => {
    // No module, transition, glossary or dependency in this corpus mentions the target
    // requirement, so all of them score zero on keyword overlap. They used to be
    // dropped outright beyond the first three, which capped those categories at three
    // entries on any model. A large window must now be able to carry the whole corpus.
    const selection = selectionFor(buildTestCaseGenerationMarkdownPrompt, {
      projectKnowledgeBase: knowledge, maxInputTokens: 200_000,
    });

    expect(selection.modules).toBe(knowledge.modules.length);
    expect(selection.crossDependencies).toBe(knowledge.crossDependencies.length);
    expect(selection.stateTransitions).toBe(knowledge.stateTransitions.length);
  });

  it("does not let per-category floors overrun the model window", () => {
    // A 4k window cannot afford all 22 floor entries. Unbounded floors would take them
    // anyway and crowd out the work item the prompt exists to reason about.
    const maxInputTokens = 4_000;
    const result = buildTestCaseGenerationMarkdownPrompt({
      currentProject, targetRequirement, outputContract,
      projectKnowledgeBase: knowledge, maxInputTokens,
    });
    const knowledgeTokens = JSON.stringify(result.relevantProjectKnowledgeBase).length / 4;

    expect(knowledgeTokens).toBeGreaterThan(0);
    expect(knowledgeTokens).toBeLessThan(maxInputTokens * 0.5);
    expect(result.prompt).toContain("Checkout");
  });

  it("treats a semantic ranking override as the eligible set, not just an ordering", () => {
    // The override arrives already cut at a relevance threshold. Admitting the entries
    // it left out would put back exactly what the threshold removed: a category always
    // has a best entry, even when it has nothing to do with the work item.
    const override = { modules: ["mod-57", "mod-58"], crossDependencies: [] };
    const selection = selectionFor(buildTestCaseGenerationMarkdownPrompt, {
      projectKnowledgeBase: knowledge, maxInputTokens: 200_000, rankedKnowledgeKeys: override,
    });

    expect(selection.moduleIds).toEqual(["mod-57", "mod-58"]);
    expect(selection.crossDependencies).toBe(0);
    // Categories the override does not mention keep keyword ranking.
    expect(selection.glossary).toBeGreaterThan(0);
    expect(selection.businessRules).toBeGreaterThan(0);
  });

  it("falls back to keyword ranking for every category when no override is supplied", () => {
    const selection = selectionFor(buildTestCaseGenerationMarkdownPrompt, {
      projectKnowledgeBase: knowledge, maxInputTokens: 200_000,
    });

    expect(selection.modules).toBe(knowledge.modules.length);
    expect(selection.crossDependencies).toBe(knowledge.crossDependencies.length);
  });
});
