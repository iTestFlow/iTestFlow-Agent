import { describe, expect, it } from "vitest";

import { describeAgentAction, validateAgentDecision } from "./agent-decision";

const context = {
  snapshotRefs: new Set(["e1", "e2", "e5"]),
  allowedOrigin: "https://app.example.com",
  secretNames: ["PASSWORD"],
};

describe("validateAgentDecision — verdicts", () => {
  it("requires actualResult on pass/fail verdicts", () => {
    expect(validateAgentDecision({ decision: "step_passed" }, context).kind).toBe("invalid");
    expect(
      validateAgentDecision({ decision: "step_passed", actualResult: "Toast 'Saved' visible" }, context),
    ).toEqual({ kind: "step_passed", actualResult: "Toast 'Saved' visible" });
    expect(
      validateAgentDecision({ decision: "step_failed", actualResult: "Error banner shown" }, context).kind,
    ).toBe("step_failed");
  });

  it("blocked carries a reason with a fallback", () => {
    expect(validateAgentDecision({ decision: "blocked", reason: "Needs OTP" }, context)).toEqual({
      kind: "blocked",
      reason: "Needs OTP",
    });
    expect(validateAgentDecision({ decision: "blocked" }, context).kind).toBe("blocked");
  });
});

describe("validateAgentDecision — actions", () => {
  it("accepts a click on a ref that exists in the shown snapshot", () => {
    const result = validateAgentDecision(
      { decision: "act", actionType: "click", ref: "e5", elementDescription: "Save button" },
      context,
    );
    expect(result).toEqual({
      kind: "action",
      action: { type: "click", ref: "e5", elementDescription: "Save button" },
    });
  });

  it("decodes the compact argumentsJson envelope used by multi-layer prompts", () => {
    expect(validateAgentDecision({
      decision: "act",
      actionType: "fill",
      argumentsJson: JSON.stringify({
        ref: "e2",
        elementDescription: "Password",
        value: "{{secret:PASSWORD}}",
      }),
    }, context)).toEqual({
      kind: "action",
      action: {
        type: "fill",
        ref: "e2",
        elementDescription: "Password",
        value: "{{secret:PASSWORD}}",
      },
    });
    expect(validateAgentDecision({
      decision: "act",
      actionType: "click",
      argumentsJson: "not-json",
    }, context).kind).toBe("invalid");
  });

  it("rejects hallucinated refs with actionable feedback", () => {
    const result = validateAgentDecision(
      { decision: "act", actionType: "click", ref: "e99", elementDescription: "x" },
      context,
    );
    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") expect(result.feedback).toContain("e99");
  });

  it("rejects action types outside the allowlist", () => {
    for (const actionType of ["evaluate", "runCode", "upload", "assertVisible", ""]) {
      expect(validateAgentDecision({ decision: "act", actionType, ref: "e1" }, context).kind).toBe("invalid");
    }
  });

  it("enforces the origin policy on navigation, allowing relative URLs", () => {
    expect(
      validateAgentDecision({ decision: "act", actionType: "navigate", url: "/orders" }, context),
    ).toEqual({ kind: "action", action: { type: "navigate", url: "/orders" } });
    const offOrigin = validateAgentDecision(
      { decision: "act", actionType: "navigate", url: "https://evil.example.net/" },
      context,
    );
    expect(offOrigin.kind).toBe("invalid");
  });

  it("fills may reference only known secrets", () => {
    expect(
      validateAgentDecision(
        { decision: "act", actionType: "fill", ref: "e2", value: "{{secret:PASSWORD}}" },
        context,
      ).kind,
    ).toBe("action");
    const unknown = validateAgentDecision(
      { decision: "act", actionType: "fill", ref: "e2", value: "{{secret:OTP}}" },
      context,
    );
    expect(unknown.kind).toBe("invalid");
    if (unknown.kind === "invalid") expect(unknown.feedback).toContain("OTP");
  });

  it("validates pressKey and waitForText fields", () => {
    expect(validateAgentDecision({ decision: "act", actionType: "pressKey", key: "Enter" }, context).kind).toBe("action");
    expect(validateAgentDecision({ decision: "act", actionType: "pressKey", key: "F12" }, context).kind).toBe("invalid");
    expect(
      validateAgentDecision({ decision: "act", actionType: "waitForText", waitText: "Welcome" }, context).kind,
    ).toBe("action");
    expect(validateAgentDecision({ decision: "act", actionType: "waitForText" }, context).kind).toBe("invalid");
  });
});

describe("describeAgentAction", () => {
  it("never includes fill values (they may hold secret placeholders)", () => {
    const validated = validateAgentDecision(
      { decision: "act", actionType: "fill", ref: "e2", elementDescription: "Password", value: "{{secret:PASSWORD}}" },
      context,
    );
    if (validated.kind !== "action") throw new Error("fixture invalid");
    const description = describeAgentAction(validated.action);
    expect(description).toContain("Password");
    expect(description).not.toContain("{{secret");
  });
});
