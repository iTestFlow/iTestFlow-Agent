import { describe, expect, it } from "vitest";
import { reconcileJiraFields } from "./jira-sync-conflict";

describe("reconcileJiraFields", () => {
  it("pulls remote-only edits and pushes local-only edits", () => {
    expect(reconcileJiraFields({
      baseline: { title: "Old", state: "Open" },
      local: { title: "Local", state: "Open" },
      remote: { title: "Old", state: "Done" },
    })).toEqual({
      merged: { title: "Local", state: "Done" },
      pulls: { state: "Done" }, pushes: { title: "Local" }, conflicts: [],
    });
  });

  it("blocks divergent writes field-by-field without discarding either value", () => {
    expect(reconcileJiraFields({
      baseline: { title: "Old" }, local: { title: "Local" }, remote: { title: "Remote" },
    })).toEqual({
      merged: { title: "Local" }, pulls: {}, pushes: {},
      conflicts: [{ field: "title", baseline: "Old", local: "Local", remote: "Remote" }],
    });
  });

  it("treats equal concurrent edits as converged", () => {
    expect(reconcileJiraFields({
      baseline: { state: "Open" }, local: { state: "Done" }, remote: { state: "Done" },
    })).toMatchObject({ merged: { state: "Done" }, pulls: {}, pushes: {}, conflicts: [] });
  });
});
