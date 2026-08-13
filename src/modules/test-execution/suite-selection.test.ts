import { describe, expect, it } from "vitest";
import type { TestSuite } from "@/modules/integrations/core/integration-types";
import { selectedSuiteIds } from "./suite-selection";

describe("selectedSuiteIds", () => {
  it("includes the selected suite and every descendant exactly once", () => {
    const tree: TestSuite[] = [{
      id: "1", name: "root", planId: "9", children: [
        { id: "2", name: "child", planId: "9", children: [{ id: "3", name: "leaf", planId: "9" }] },
        { id: "4", name: "sibling", planId: "9" },
      ],
    }];
    expect(selectedSuiteIds(tree, "2")).toEqual(["2", "3"]);
  });

  it("fails when the selected suite is outside the returned plan tree", () => {
    expect(() => selectedSuiteIds([], "99")).toThrow("not found");
  });
});
