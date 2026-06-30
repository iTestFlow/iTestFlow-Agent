import { describe, expect, it } from "vitest";

import {
  assertProjectScope,
  assertSameAzureProject,
  ProjectIsolationError,
  workItemNotInProjectMessage,
} from "./project-isolation.guard";
import { projectScope } from "@/test/factories";

describe("project isolation guard", () => {
  it("accepts and returns a complete trusted scope", () => {
    expect(assertProjectScope(projectScope())).toEqual(projectScope());
  });

  it.each([null, {}, { projectId: "x" }, projectScope({ azureOrganizationUrl: "not-a-url" })])(
    "rejects an invalid scope",
    (value) => expect(() => assertProjectScope(value)).toThrow(ProjectIsolationError),
  );

  it("uses the default guidance message for an invalid scope", () => {
    expect(() => assertProjectScope(null)).toThrow(
      "Please select an Azure DevOps project before running this action.",
    );
  });

  it("accepts a record whose Azure project matches the active scope", () => {
    const scope = projectScope();
    expect(() => assertSameAzureProject(scope, scope.azureProjectId)).not.toThrow();
  });

  it("rejects cross-project records without disclosing details", () => {
    expect(() => assertSameAzureProject(projectScope(), "other")).toThrow(
      "does not match the target record",
    );
    expect(workItemNotInProjectMessage(123)).toContain("not found in the selected project");
  });

  it("embeds a string work item id in the not-found message", () => {
    expect(workItemNotInProjectMessage("AB#5")).toContain("Work item AB#5");
  });
});
