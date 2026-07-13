import { describe, expect, it } from "vitest";

import {
  buildExistingTestCaseReviewMarkdownPrompt,
  buildRequirementAnalysisMarkdownPrompt,
  buildTestCaseGenerationMarkdownPrompt,
  buildTestExecutionEffortMarkdownPrompt,
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
      buildTestExecutionEffortMarkdownPrompt(inputs).prompt,
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

  it("ranks knowledge by priority sources and term hits, keeps the first three, and truncates the tail", () => {
    const { prompt, relevantProjectKnowledgeBase } = buildRequirementAnalysisMarkdownPrompt({
      currentProject,
      targetRequirement,
      projectKnowledgeBase: knowledgeBase(),
      outputContract,
    });

    // Modules: budget of 6 keeps priority-source items first, then original order among equal scores.
    expect(relevantProjectKnowledgeBase?.modules.map((item) => item.id)).toEqual([
      "mod-payments",
      "mod-cart",
      "mod-shipping",
      "mod-returns",
      "mod-invoicing",
      "mod-catalog",
    ]);
    // Business rules: priority source outranks term hits; zero-score items survive only inside the first three.
    expect(relevantProjectKnowledgeBase?.businessRules.map((item) => item.id)).toEqual([
      "card-verify",
      "cod-limit",
      "loyalty-round",
      "stock-hold",
    ]);
    expect(prompt).not.toContain("mod-search");
    expect(prompt).not.toContain("mod-profile");
    expect(prompt).not.toContain("gift-wrap");

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
