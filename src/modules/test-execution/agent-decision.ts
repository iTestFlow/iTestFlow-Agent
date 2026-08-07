import {
  AGENT_ACTION_TYPES,
  AgentDecisionSchema,
  PRESS_KEYS,
  REF_REQUIRED_ACTIONS,
  type AgentAction,
  type AgentActionType,
} from "./action-schema";
import { extractSecretReferences } from "./secret-resolution";

/**
 * Deterministic validation of a model-proposed decision — THE safety boundary
 * of agentic execution. The model only ever supplies data; this module decides
 * whether that data describes a permissible action:
 *  - action type must be in the fixed allowlist,
 *  - element refs must exist in the snapshot the model was actually shown
 *    (hallucinated refs are rejected with feedback, never guessed around),
 *  - navigation must stay inside the allowed origin,
 *  - secret references must name existing secrets (values are substituted
 *    later, in worker memory — never by or for the model).
 */

export const MAX_AGENT_VALUE_LENGTH = 1_000;

export type DecisionContext = {
  snapshotRefs: ReadonlySet<string>;
  allowedOrigin: string;
  secretNames: readonly string[];
};

export type ValidatedDecision =
  | { kind: "action"; action: AgentAction }
  | { kind: "step_passed"; actualResult: string }
  | { kind: "step_failed"; actualResult: string }
  | { kind: "blocked"; reason: string }
  | { kind: "invalid"; feedback: string };

export function validateAgentDecision(raw: unknown, context: DecisionContext): ValidatedDecision {
  const parsed = AgentDecisionSchema.safeParse(raw);
  if (!parsed.success) {
    return { kind: "invalid", feedback: "Your response did not match the required JSON shape." };
  }
  const decision = parsed.data;

  if (decision.decision === "step_passed" || decision.decision === "step_failed") {
    const actualResult = decision.actualResult?.trim();
    if (!actualResult) {
      return {
        kind: "invalid",
        feedback: `A ${decision.decision} verdict must include actualResult describing what you observed.`,
      };
    }
    return { kind: decision.decision, actualResult: actualResult.slice(0, 2_000) };
  }

  if (decision.decision === "blocked") {
    return { kind: "blocked", reason: (decision.reason?.trim() || "The step cannot proceed.").slice(0, 1_000) };
  }

  // decision === "act"
  const actionType = decision.actionType as AgentActionType | undefined;
  if (!actionType || !(AGENT_ACTION_TYPES as readonly string[]).includes(actionType)) {
    return {
      kind: "invalid",
      feedback: `actionType must be one of: ${AGENT_ACTION_TYPES.join(", ")}.`,
    };
  }

  if (REF_REQUIRED_ACTIONS.has(actionType)) {
    const ref = decision.ref?.trim();
    if (!ref) {
      return { kind: "invalid", feedback: `${actionType} requires a ref from the page snapshot.` };
    }
    if (!context.snapshotRefs.has(ref)) {
      return {
        kind: "invalid",
        feedback: `ref "${ref}" does not exist in the current page snapshot. Use only [ref=…] values from the snapshot you were shown.`,
      };
    }
    const elementDescription = (decision.elementDescription?.trim() || "element").slice(0, 200);

    if (actionType === "fill" || actionType === "select") {
      const value = decision.value ?? "";
      if (value.length === 0 || value.length > MAX_AGENT_VALUE_LENGTH) {
        return { kind: "invalid", feedback: `${actionType} requires a value of 1-${MAX_AGENT_VALUE_LENGTH} characters.` };
      }
      const unknownSecret = extractSecretReferences(value).find((name) => !context.secretNames.includes(name));
      if (unknownSecret) {
        return {
          kind: "invalid",
          feedback: `{{secret:${unknownSecret}}} is not an available secret. Available: ${context.secretNames.join(", ") || "(none)"}.`,
        };
      }
      return { kind: "action", action: { type: actionType, ref, elementDescription, value } };
    }
    return {
      kind: "action",
      action: { type: actionType as "click" | "check" | "uncheck" | "hover", ref, elementDescription },
    };
  }

  switch (actionType) {
    case "navigate": {
      const url = decision.url?.trim();
      if (!url) return { kind: "invalid", feedback: "navigate requires a url." };
      let origin: string;
      try {
        origin = new URL(url, context.allowedOrigin).origin;
      } catch {
        return { kind: "invalid", feedback: `"${url}" is not a valid URL.` };
      }
      let allowed: string;
      try {
        allowed = new URL(context.allowedOrigin).origin;
      } catch {
        return { kind: "invalid", feedback: "The environment's allowed origin is invalid." };
      }
      if (origin !== allowed) {
        return {
          kind: "invalid",
          feedback: `Navigation outside ${allowed} is not allowed. Stay on the application under test.`,
        };
      }
      return { kind: "action", action: { type: "navigate", url } };
    }
    case "pressKey": {
      const key = decision.key?.trim();
      if (!key || !(PRESS_KEYS as readonly string[]).includes(key)) {
        return { kind: "invalid", feedback: `key must be one of: ${PRESS_KEYS.join(", ")}.` };
      }
      return { kind: "action", action: { type: "pressKey", key: key as (typeof PRESS_KEYS)[number] } };
    }
    case "waitForText": {
      const text = decision.waitText?.trim();
      if (!text || text.length > 200) {
        return { kind: "invalid", feedback: "waitForText requires waitText of 1-200 characters." };
      }
      return { kind: "action", action: { type: "waitForText", text } };
    }
    case "screenshot":
      return { kind: "action", action: { type: "screenshot" } };
    default:
      return { kind: "invalid", feedback: `Unsupported actionType "${actionType}".` };
  }
}

/** Compact, scrub-safe transcript line for observations and the report. */
export function describeAgentAction(action: AgentAction): string {
  switch (action.type) {
    case "navigate":
      return `Navigate to ${action.url}`;
    case "click":
      return `Click ${action.elementDescription} [${action.ref}]`;
    case "check":
      return `Check ${action.elementDescription} [${action.ref}]`;
    case "uncheck":
      return `Uncheck ${action.elementDescription} [${action.ref}]`;
    case "hover":
      return `Hover ${action.elementDescription} [${action.ref}]`;
    case "fill":
      return `Fill ${action.elementDescription} [${action.ref}]`;
    case "select":
      return `Select "${action.value}" in ${action.elementDescription} [${action.ref}]`;
    case "pressKey":
      return `Press ${action.key}`;
    case "waitForText":
      return `Wait for text "${action.text}"`;
    case "screenshot":
      return "Capture screenshot";
  }
}
