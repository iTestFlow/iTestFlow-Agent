import { NaturalPlanSchema, type NaturalPlan } from "./action-schema";
import { extractSecretReferences } from "./secret-resolution";

/**
 * Natural-plan validation — the shared gate used by the editor, the
 * run-create route, and the worker. Structural errors block; unknown
 * {{secret:NAME}} references surface as warnings (the agent would hit them
 * as blocked_prerequisite at run time, so the reviewer should know early).
 */

export type PlanFinding = {
  severity: "error" | "warning";
  code: "invalid_plan" | "unknown_secret";
  message: string;
  stepIndex?: number;
};

export type PlanValidationContext = {
  availableSecretNames: readonly string[];
  /** Omit for draft-only validation; run approval supplies the frozen targets. */
  availableLayers?: readonly ("ui" | "api" | "db")[];
};

export type PlanValidationResult =
  | { ok: true; plan: NaturalPlan; findings: PlanFinding[] }
  | { ok: false; findings: PlanFinding[] };

export function validateNaturalPlan(
  input: unknown,
  context: PlanValidationContext,
): PlanValidationResult {
  const parsed = NaturalPlanSchema.safeParse(input);
  if (!parsed.success) {
    const findings: PlanFinding[] = parsed.error.issues.slice(0, 20).map((issue) => ({
      severity: "error",
      code: "invalid_plan",
      message: `${issue.path.join(".") || "plan"}: ${issue.message}`,
      stepIndex: typeof issue.path[1] === "number" ? issue.path[1] : undefined,
    }));
    return { ok: false, findings };
  }

  const findings: PlanFinding[] = [];
  parsed.data.steps.forEach((step, stepIndex) => {
    const availableLayers = context.availableLayers;
    if (availableLayers) {
      const unavailable = (step.layerHint === "ui" || step.layerHint === "api" || step.layerHint === "db") &&
        !availableLayers.includes(step.layerHint);
      const insufficientMixedTargets = step.layerHint === "mixed" && new Set(availableLayers).size < 2;
      if (unavailable || insufficientMixedTargets) {
        findings.push({
          severity: "error",
          code: "invalid_plan",
          message: unavailable
            ? `Step ${stepIndex + 1} requires the ${step.layerHint.toUpperCase()} layer, but that target is not configured.`
            : `Step ${stepIndex + 1} is Mixed and requires at least two configured execution layers.`,
          stepIndex,
        });
      }
    }
    for (const name of extractSecretReferences(`${step.instruction}\n${step.expectedResult}`)) {
      if (!context.availableSecretNames.includes(name)) {
        findings.push({
          severity: "warning",
          code: "unknown_secret",
          message: `Step ${stepIndex + 1} references {{secret:${name}}}, which is not defined for this environment.`,
          stepIndex,
        });
      }
    }
  });
  if (findings.some((finding) => finding.severity === "error")) {
    return { ok: false, findings };
  }
  return { ok: true, plan: parsed.data, findings };
}

/** Distinct secret names referenced anywhere in a natural plan's text. */
export function collectNaturalPlanSecretReferences(plan: NaturalPlan): string[] {
  const names: string[] = [];
  for (const step of plan.steps) {
    for (const name of extractSecretReferences(`${step.instruction}\n${step.expectedResult}`)) {
      if (!names.includes(name)) names.push(name);
    }
  }
  return names;
}
