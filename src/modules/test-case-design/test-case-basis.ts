import { z } from "zod";

export const TEST_CASE_OUTPUT_CONTRACT_VERSION = "2";
export const EXTRA_INSTRUCTIONS_SOURCE_ID = "EXTRA:instructions";

export const TestCaseBasisSchema = z.object({
  kind: z.enum(["requirement", "derived", "project_rule", "suggested"]),
  explanation: z.string().trim().min(1),
  sourceReferences: z.array(z.string().trim().min(1)),
});

export type TestCaseBasis = z.infer<typeof TestCaseBasisSchema>;

export const testCaseBasisLabels: Record<TestCaseBasis["kind"], string> = {
  requirement: "Requirement",
  derived: "Derived",
  project_rule: "Project rule",
  suggested: "Suggested coverage",
};

export function isSupportedTestCase(testCase: { basis?: TestCaseBasis }) {
  return testCase.basis !== undefined && testCase.basis.kind !== "suggested";
}

export function normalizeSuggestedTestCaseTitle<T extends { title?: string; basis?: TestCaseBasis }>(testCase: T): T {
  if (testCase.basis?.kind !== "suggested" || typeof testCase.title !== "string") return testCase;
  const title = testCase.title.replace(/(?:\s*\(\s*suggested\s*\))+\s*$/i, "");
  return title.trim() && title !== testCase.title ? { ...testCase, title } : testCase;
}

/** Preserve origin on every publishing backend, including retries of an annotated draft. */
export function withSuggestionOrigin<T extends { title?: string; description?: string; basis?: TestCaseBasis }>(testCase: T): T {
  if (testCase.basis?.kind !== "suggested") return testCase;
  const normalized = normalizeSuggestedTestCaseTitle(testCase);
  const note = `Suggested coverage — proposed assumption: ${testCase.basis.explanation}`;
  const description = normalized.description ?? "";
  return { ...normalized, description: description.includes(note) ? description : [description, note].filter(Boolean).join("\n\n") };
}
