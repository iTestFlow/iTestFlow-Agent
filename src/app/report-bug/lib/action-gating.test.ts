import { describe, expect, it } from "vitest";

import { getReportBugActionGates } from "./action-gating";

function readyInput() {
  return {
    hasScope: true,
    bugDescription: "Checkout fails after payment.",
    metadataLoading: false,
    generationRunning: false,
    preparationRunning: false,
    parentStoryInvalid: false,
    parentStoryValid: true,
    report: {
      title: "Checkout fails",
      actualResult: "A 500 page is shown.",
      stepsToReproduce: "Submit payment.",
    },
    posting: false,
    hasPostedBug: true,
    publishingTestCase: false,
    hasSuggestedTestCase: true,
    suggestedTestCaseValid: true,
  };
}

describe("report bug action gating", () => {
  it("enables all actions when their user-visible prerequisites are complete", () => {
    expect(getReportBugActionGates(readyInput())).toEqual({
      generateDisabled: false,
      postDisabled: false,
      publishTestCaseDisabled: false,
    });
  });

  it.each([
    ["project scope is missing", { hasScope: false }],
    ["description is blank", { bugDescription: "  " }],
    ["metadata is loading", { metadataLoading: true }],
    ["generation is running", { generationRunning: true }],
    ["manual preparation is running", { preparationRunning: true }],
    ["the selected parent is not a user story", { parentStoryInvalid: true }],
  ])("disables generation when %s", (_label, patch) => {
    expect(getReportBugActionGates({ ...readyInput(), ...patch }).generateDisabled).toBe(true);
  });

  it.each([
    ["the report is absent", { report: null }],
    ["the title is blank", { report: { ...readyInput().report, title: " " } }],
    ["the actual result is blank", { report: { ...readyInput().report, actualResult: "" } }],
    ["the reproduction steps are blank", { report: { ...readyInput().report, stepsToReproduce: "" } }],
    ["posting is already running", { posting: true }],
    ["the selected parent is invalid", { parentStoryInvalid: true }],
  ])("disables posting when %s", (_label, patch) => {
    expect(getReportBugActionGates({ ...readyInput(), ...patch }).postDisabled).toBe(true);
  });

  it.each([
    ["project scope is missing", { hasScope: false }],
    ["a valid parent story is missing", { parentStoryValid: false }],
    ["the bug has not been posted", { hasPostedBug: false }],
    ["publishing is already running", { publishingTestCase: true }],
    ["there is no suggested case", { hasSuggestedTestCase: false }],
    ["the suggested case is invalid", { suggestedTestCaseValid: false }],
  ])("disables reproduction-case publishing when %s", (_label, patch) => {
    expect(getReportBugActionGates({ ...readyInput(), ...patch }).publishTestCaseDisabled).toBe(true);
  });

  it("keeps generation available for an optional empty parent while blocking reproduction publishing", () => {
    const gates = getReportBugActionGates({
      ...readyInput(),
      parentStoryValid: false,
      hasPostedBug: false,
    });

    expect(gates.generateDisabled).toBe(false);
    expect(gates.publishTestCaseDisabled).toBe(true);
  });
});
