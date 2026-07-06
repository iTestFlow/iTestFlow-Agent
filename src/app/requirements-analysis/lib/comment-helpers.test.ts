import { describe, expect, it } from "vitest";

import type { RequirementFinding } from "@/components/workflow/test-intelligence-types";
import type { ProjectUser } from "@/types/azure-devops";

import { buildCommentBodyWithMentions, severityRank } from "./comment-helpers";

function makeFinding(overrides: Partial<RequirementFinding> = {}): RequirementFinding {
  return {
    id: "RF-1",
    checklistItemId: "ambiguity_clarity",
    issueType: "ambiguity",
    severity: "medium",
    title: "Ambiguous expiry rule",
    description: "The quote expiry window is not defined.",
    suggestion: "State the exact expiry duration.",
    riskLevel: "medium",
    riskJustification: "Testers cannot derive expected results.",
    affectedAreas: ["Quotes"],
    references: [],
    contradiction: false,
    ...overrides,
  };
}

function makeUser(overrides: Partial<ProjectUser> = {}): ProjectUser {
  return {
    id: "aaaa1111-0000-4000-8000-000000000001",
    displayName: "Jane Doe",
    uniqueName: "jane.doe@contoso.com",
    ...overrides,
  };
}

describe("severityRank", () => {
  it("sorts findings critical, high, medium, low, info via the review sort call site", () => {
    const findings = [
      makeFinding({ id: "F-info", severity: "info" }),
      makeFinding({ id: "F-low", severity: "low" }),
      makeFinding({ id: "F-critical", severity: "critical" }),
      makeFinding({ id: "F-medium", severity: "medium" }),
      makeFinding({ id: "F-high", severity: "high" }),
    ];
    // Exact expression used by the client's sortedFindingList memo.
    const sorted = [...findings].sort((left, right) => severityRank(left.severity) - severityRank(right.severity));
    expect(sorted.map((finding) => finding.id)).toEqual(["F-critical", "F-high", "F-medium", "F-low", "F-info"]);
  });

  it("ranks unknown severities after every known severity, including info", () => {
    const unknown = "blocker" as RequirementFinding["severity"];
    for (const severity of ["critical", "high", "medium", "low", "info"] as const) {
      expect(severityRank(unknown)).toBeGreaterThan(severityRank(severity));
    }
  });

  it("sorts unknown severities last and keeps insertion order for equal ranks", () => {
    const findings = [
      makeFinding({ id: "F-unknown", severity: "blocker" as RequirementFinding["severity"] }),
      makeFinding({ id: "F-high-1", severity: "high" }),
      makeFinding({ id: "F-high-2", severity: "high" }),
    ];
    const sorted = [...findings].sort((left, right) => severityRank(left.severity) - severityRank(right.severity));
    expect(sorted.map((finding) => finding.id)).toEqual(["F-high-1", "F-high-2", "F-unknown"]);
  });
});

describe("buildCommentBodyWithMentions", () => {
  it("returns the body byte-identical when no users are mentioned (no trim, no markup)", () => {
    const body = "  ## Findings\n\n<strong>R1</strong> is ambiguous.\n";
    expect(buildCommentBodyWithMentions(body, [])).toBe(body);
  });

  it("prepends exactly one @<id> mention token followed by a blank line for a single user", () => {
    const user = makeUser();
    const result = buildCommentBodyWithMentions("## Findings\n\nBody text.", [user]);
    expect(result).toBe(`@<${user.id}>\n\n## Findings\n\nBody text.`);
  });

  it("emits one mention token per user, space-separated, in selection order, using the id (not display name)", () => {
    const users = [
      makeUser({ id: "id-jane", displayName: "Jane Doe" }),
      makeUser({ id: "id-omar", displayName: "Omar Ali", uniqueName: "omar.ali@contoso.com" }),
      makeUser({ id: "id-lina", displayName: "Lina Haddad", uniqueName: "lina.haddad@contoso.com" }),
    ];
    const result = buildCommentBodyWithMentions("Body.", users);
    expect(result).toBe("@<id-jane> @<id-omar> @<id-lina>\n\nBody.");
    // The posted markup carries only the id; display/unique names ride separately in the API payload.
    for (const user of users) {
      expect(result.split(`@<${user.id}>`).length - 1).toBe(1);
      expect(result).not.toContain(user.displayName);
    }
  });

  it("prepends the mention line even when the user is already referenced by display name in the body (no dedup)", () => {
    const jane = makeUser({ id: "id-jane", displayName: "Jane Doe" });
    const body = "As discussed with @Jane Doe, R2 conflicts with R7.";
    // The helper never inspects the body for existing references — the id token is always prepended.
    expect(buildCommentBodyWithMentions(body, [jane])).toBe(`@<id-jane>\n\n${body}`);
  });

  it("preserves HTML in the body untouched around the injected markup", () => {
    const user = makeUser({ id: "id-jane" });
    const html = "<table><tr><td>R1 &amp; R2</td></tr></table>\n<a href=\"https://dev.azure.com/item/42\">#42</a>";
    const result = buildCommentBodyWithMentions(html, [user]);
    expect(result).toBe(`@<id-jane>\n\n${html}`);
  });

  it("trims only the body's outer whitespace when mentions are injected; inner content is untouched", () => {
    const user = makeUser({ id: "id-jane" });
    const result = buildCommentBodyWithMentions("\n\n## Header\n\ntext  <em>kept</em>\n\n", [user]);
    expect(result).toBe("@<id-jane>\n\n## Header\n\ntext  <em>kept</em>");
  });
});
