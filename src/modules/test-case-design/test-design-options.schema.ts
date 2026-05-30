import { z } from "zod";
import {
  allCoverageFocusIds,
  coverageFocusIdValues,
  defaultTestDesignOptions,
  maxCustomTestCaseRange,
  targetTestCaseRangeIdValues,
  type TestDesignOptions,
} from "./test-design-options";

const TargetTestCaseRangeIdSchema = z.enum(targetTestCaseRangeIdValues);
const CoverageFocusIdSchema = z.enum(coverageFocusIdValues);

export const TestDesignOptionsRequestSchema = z
  .object({
    targetTestCaseRange: TargetTestCaseRangeIdSchema.default(defaultTestDesignOptions.targetTestCaseRange),
    customMinCases: z.number().int().min(1).max(maxCustomTestCaseRange).optional(),
    customMaxCases: z.number().int().min(1).max(maxCustomTestCaseRange).optional(),
    coverageFocusIds: z.array(CoverageFocusIdSchema).min(1, "Select at least one Coverage Focus item.").default([...allCoverageFocusIds]),
  })
  .superRefine((options, ctx) => {
    if (options.targetTestCaseRange !== "custom") return;

    if (options.customMinCases === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["customMinCases"],
        message: "Enter a custom minimum test case count.",
      });
    }

    if (options.customMaxCases === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["customMaxCases"],
        message: "Enter a custom maximum test case count.",
      });
    }

    if (
      options.customMinCases !== undefined &&
      options.customMaxCases !== undefined &&
      options.customMinCases > options.customMaxCases
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["customMaxCases"],
        message: "Custom maximum must be greater than or equal to the custom minimum.",
      });
    }
  })
  .transform((options): TestDesignOptions => ({
    targetTestCaseRange: options.targetTestCaseRange,
    customMinCases: options.targetTestCaseRange === "custom" ? options.customMinCases : undefined,
    customMaxCases: options.targetTestCaseRange === "custom" ? options.customMaxCases : undefined,
    coverageFocusIds: allCoverageFocusIds.filter((id) => options.coverageFocusIds.includes(id)),
  }));
