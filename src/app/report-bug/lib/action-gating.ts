export type BugReportRequiredFields = {
  title: string;
  actualResult: string;
  stepsToReproduce: string;
};

export function getReportBugActionGates(input: {
  hasScope: boolean;
  bugDescription: string;
  metadataLoading: boolean;
  generationRunning: boolean;
  preparationRunning: boolean;
  parentStoryInvalid: boolean;
  parentStoryValid: boolean;
  report: BugReportRequiredFields | null;
  posting: boolean;
  hasPostedBug: boolean;
  publishingTestCase: boolean;
  hasSuggestedTestCase: boolean;
  suggestedTestCaseValid: boolean;
}) {
  return {
    generateDisabled:
      !input.hasScope ||
      !input.bugDescription.trim() ||
      input.metadataLoading ||
      input.generationRunning ||
      input.preparationRunning ||
      input.parentStoryInvalid,
    postDisabled:
      !input.hasScope ||
      !input.report ||
      !input.report.title.trim() ||
      !input.report.actualResult.trim() ||
      !input.report.stepsToReproduce.trim() ||
      input.posting ||
      input.parentStoryInvalid,
    publishTestCaseDisabled:
      !input.hasScope ||
      !input.parentStoryValid ||
      !input.hasPostedBug ||
      input.publishingTestCase ||
      !input.hasSuggestedTestCase ||
      !input.suggestedTestCaseValid,
  };
}
