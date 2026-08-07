import { describe, expect, it } from "vitest";

import { collectSnapshotRefs, findSnapshotCheckedState, parseAriaSnapshot } from "./aria-snapshot";

const SNAPSHOT = [
  '- banner [ref=e2]:',
  '  - heading "Dashboard" [level=1] [ref=e3]',
  '  - button "Save" [ref=e5] [cursor=pointer]',
  '- main [ref=e10]:',
  '  - textbox "Email" [ref=e11]',
  '  - checkbox "Accept terms" [checked] [ref=e12]',
  '  - checkbox "Subscribe" [ref=e13]',
  '  - button "Delete" [disabled] [ref=e14]',
  '  - text: Plain informational text',
].join("\n");

describe("parseAriaSnapshot", () => {
  it("parses roles, names, refs, and state attributes", () => {
    const nodes = parseAriaSnapshot(SNAPSHOT);
    expect(nodes.find((n) => n.ref === "e5")).toMatchObject({ role: "button", name: "Save" });
    expect(nodes.find((n) => n.ref === "e12")?.checked).toBe(true);
    expect(nodes.find((n) => n.ref === "e13")?.checked).toBe(false);
    expect(nodes.find((n) => n.ref === "e14")?.disabled).toBe(true);
  });

  it("skips plain text lines and strips list markers from labels", () => {
    const nodes = parseAriaSnapshot(SNAPSHOT);
    expect(nodes.some((n) => n.name.includes("Plain informational"))).toBe(false);
    expect(nodes.find((n) => n.ref === "e2")?.line).toBe("banner [ref=e2]");
  });
});

describe("collectSnapshotRefs", () => {
  it("returns exactly the refs the model may target", () => {
    const refs = collectSnapshotRefs(SNAPSHOT);
    expect(refs.has("e5")).toBe(true);
    expect(refs.has("e12")).toBe(true);
    expect(refs.has("e99")).toBe(false);
    expect(refs.size).toBe(8);
  });
});

describe("findSnapshotCheckedState", () => {
  it("reads toggle state by ref", () => {
    expect(findSnapshotCheckedState(SNAPSHOT, "e12")).toBe(true);
    expect(findSnapshotCheckedState(SNAPSHOT, "e13")).toBe(false);
    expect(findSnapshotCheckedState(SNAPSHOT, "e5")).toBeNull();
    expect(findSnapshotCheckedState(SNAPSHOT, "missing")).toBeNull();
  });
});
