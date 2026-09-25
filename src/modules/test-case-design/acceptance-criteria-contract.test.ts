import { describe, expect, it } from "vitest";
import { buildAcceptanceCriteriaContract } from "./acceptance-criteria-contract";
import { evaluateAcceptanceCriteriaCoverage } from "./acceptance-criteria-coverage";

describe("selected-story acceptance criteria contract", () => {
  it("keeps HTML list order, nested context, and scenario boundaries", () => {
    const contract = buildAcceptanceCriteriaContract({ title: "Checkout", description: "Pay", acceptanceCriteria: `
      <h3>Acceptance Criteria</h3><ol>
        <li>Payment methods<ul><li>Card succeeds</li><li>Cash is unavailable</li></ul></li>
        <li>Given a valid cart<br>When payment succeeds<br>Then show confirmation</li>
      </ol>` });
    expect(contract.criteria).toEqual([
      { id: "AC-001", text: "Payment methods — Card succeeds" },
      { id: "AC-002", text: "Payment methods — Cash is unavailable" },
      { id: "AC-003", text: "Given a valid cart When payment succeeds Then show confirmation" },
    ]);
    expect(buildAcceptanceCriteriaContract({ title: "Checkout", description: "Pay", acceptanceCriteria: `
      <h3>Acceptance Criteria</h3><ol>
        <li>Payment methods<ul><li>Card succeeds</li><li>Cash is unavailable</li></ul></li>
        <li>Given a valid cart<br>When payment succeeds<br>Then show confirmation</li>
      </ol>` }).sourceHash).toBe(contract.sourceHash);
  });

  it("groups plain-text scenarios and never treats model estimate as coverage", () => {
    const contract = buildAcceptanceCriteriaContract({ acceptanceCriteria: "1. Given a cart\nWhen payment succeeds\nThen confirm order\n2. Failed payment shows an error" });
    expect(contract.criteria).toEqual([
      { id: "AC-001", text: "Given a cart When payment succeeds Then confirm order" },
      { id: "AC-002", text: "Failed payment shows an error" },
    ]);
    const coverage = evaluateAcceptanceCriteriaCoverage(contract, { testCases: [
      { relatedAcceptanceCriteria: ["AC-001", "AC-001", "AC-999"] },
      { relatedAcceptanceCriteria: ["AC-001"] },
      { relatedAcceptanceCriteria: [] },
    ] });
    expect(coverage).toMatchObject({ requiredCount: 2, coveredCount: 1, missingCriteria: [{ id: "AC-002" }], unknownReferences: [{ id: "AC-999", casePosition: 1 }] });
    expect(coverage.casePositionsByCriterion["AC-001"]).toEqual([1, 2]);
    const complete = evaluateAcceptanceCriteriaCoverage(contract, { testCases: [
      { relatedAcceptanceCriteria: ["AC-001", "AC-002"] },
      { relatedAcceptanceCriteria: ["AC-002"] },
      { relatedAcceptanceCriteria: [] },
    ] });
    expect(complete).toMatchObject({ coveredCount: 2, missingCriteria: [], unknownReferences: [] });
    expect(complete.casePositionsByCriterion["AC-002"]).toEqual([1, 2]);
    const otherwiseComplete = evaluateAcceptanceCriteriaCoverage(contract, { testCases: [
      { relatedAcceptanceCriteria: ["AC-001", "AC-002", "AC-999"] },
    ] });
    expect(otherwiseComplete).toMatchObject({ coveredCount: 2, missingCriteria: [], unknownReferences: [{ id: "AC-999", casePosition: 1 }] });
  });

  it("carries plain-text nested bullet context into each leaf criterion", () => {
    const contract = buildAcceptanceCriteriaContract({ acceptanceCriteria: "- Payment methods\n  - Card succeeds\n  - Cash is unavailable\n- Order receipt appears" });
    expect(contract.criteria).toEqual([
      { id: "AC-001", text: "Payment methods — Card succeeds" },
      { id: "AC-002", text: "Payment methods — Cash is unavailable" },
      { id: "AC-003", text: "Order receipt appears" },
    ]);
  });

  it("preserves nested list context across blank Markdown list spacers", () => {
    const contract = buildAcceptanceCriteriaContract({ acceptanceCriteria: "- Payment methods\n\n  - Card succeeds\n  - Cash is unavailable\n\n- Order receipt appears" });
    expect(contract.criteria).toEqual([
      { id: "AC-001", text: "Payment methods — Card succeeds" },
      { id: "AC-002", text: "Payment methods — Cash is unavailable" },
      { id: "AC-003", text: "Order receipt appears" },
    ]);
  });

  it("keeps adjacent Given/When/Then scenarios separate without splitting prose sentences", () => {
    const contract = buildAcceptanceCriteriaContract({ acceptanceCriteria: "Given an active user\nWhen they submit\nThen save the form\nGiven a blocked user\nWhen they submit\nThen show an error" });
    expect(contract.criteria).toEqual([
      { id: "AC-001", text: "Given an active user When they submit Then save the form" },
      { id: "AC-002", text: "Given a blocked user When they submit Then show an error" },
    ]);
    expect(buildAcceptanceCriteriaContract({ acceptanceCriteria: "The first sentence is context. The second sentence is still the same source block." }).criteria).toHaveLength(1);
  });

  it("keeps an HTML scenario heading with its Given/When/Then paragraphs", () => {
    const contract = buildAcceptanceCriteriaContract({ acceptanceCriteria: "<p>Scenario: paid checkout</p><p>Given a cart</p><p>When payment succeeds</p><p>Then show a receipt</p><p>Scenario: rejected payment</p><p>Given a cart</p><p>When payment fails</p><p>Then show an error</p>" });
    expect(contract.criteria).toEqual([
      { id: "AC-001", text: "Scenario: paid checkout Given a cart When payment succeeds Then show a receipt" },
      { id: "AC-002", text: "Scenario: rejected payment Given a cart When payment fails Then show an error" },
    ]);
  });

  it("rejects absent criteria before generation", () => {
    expect(() => buildAcceptanceCriteriaContract({ title: "Story", acceptanceCriteria: "<p> </p>" })).toThrowError(/no readable acceptance criteria/i);
    expect(() => buildAcceptanceCriteriaContract({ acceptanceCriteria: "<table><tr><td>Case</td><td>Expected</td></tr></table>" })).toThrowError(/cannot be mapped safely/i);
  });
});
