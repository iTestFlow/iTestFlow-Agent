import { describe, expect, it } from "vitest";

import { normalizeExpectedWorkItemId } from "@/modules/rag/work-item-id";

describe("normalizeExpectedWorkItemId", () => {
  it.each([
    ["1234", "1234"],
    ["  1234  ", "1234"],
    ["01234", "1234"],
    ["#1234", "1234"],
    ["AB#1234", "1234"],
    ["ab#1234", "1234"],
    ["WI:1234", "1234"],
    ["wi: 1234", "1234"],
    ["https://dev.azure.com/org/project/_workitems/edit/1234", "1234"],
    ["https://dev.azure.com/org/project/_workitems/edit/1234/", "1234"],
    ["https://dev.azure.com/org/project/_workitems/edit/1234?workitem=1234", "1234"],
    ["https://dev.azure.com/org/_apis/wit/workItems/1234", "1234"],
  ])("normalizes %s to %s", (input, expected) => {
    expect(normalizeExpectedWorkItemId(input)).toBe(expected);
  });

  it.each([
    [""],
    ["   "],
    ["abc"],
    ["12 34"],
    ["12a4"],
    ["AB#"],
    ["#"],
    ["https://dev.azure.com/org/project/_backlogs/backlog"],
  ])("rejects %s", (input) => {
    expect(normalizeExpectedWorkItemId(input)).toBeNull();
  });
});
