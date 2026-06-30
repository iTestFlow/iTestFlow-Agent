import { describe, expect, it } from "vitest";

import {
  formatDuration,
  parseVitestJsonReport,
  renderVitestSummary,
  summarizeVitestReports,
  toRepositoryRelativePath,
  type LaneReport,
  type VitestAssertionResult,
  type VitestFileResult,
} from "../../scripts/render-vitest-summary";

function assertion(
  overrides: Partial<VitestAssertionResult> = {},
): VitestAssertionResult {
  return {
    ancestorTitles: ["suite"],
    fullName: "suite passes",
    status: "passed",
    title: "passes",
    duration: 5,
    failureMessages: [],
    ...overrides,
  };
}

function file(
  name: string,
  assertionResults: VitestAssertionResult[],
  overrides: Partial<VitestFileResult> = {},
): VitestFileResult {
  return {
    name,
    assertionResults,
    startTime: 100,
    endTime: 125,
    status: "passed",
    message: "",
    ...overrides,
  };
}

describe("Vitest CI summary rendering", () => {
  it("aggregates one row per file and treats non-final statuses as skipped", () => {
    const reports: LaneReport[] = [
      {
        lane: "Unit & coverage",
        report: {
          testResults: [
            file("C:\\repo\\src\\mixed.test.ts", [
              assertion(),
              assertion({ status: "skipped", title: "skipped" }),
              assertion({ status: "todo", title: "todo" }),
              assertion({
                status: "failed",
                title: "fails",
                fullName: "suite fails",
                failureMessages: ["AssertionError: boom"],
              }),
            ]),
          ],
        },
      },
    ];

    const { files, failures } = summarizeVitestReports(reports, "C:\\repo");

    expect(files).toEqual([
      {
        lane: "Unit & coverage",
        file: "src/mixed.test.ts",
        total: 4,
        passed: 1,
        skipped: 2,
        failed: 1,
        timeMs: 25,
      },
    ]);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.test).toBe("suite fails");
  });

  it("omits the failure table when every test passes", () => {
    const rendered = renderVitestSummary(
      [
        {
          lane: "Unit & coverage",
          report: {
            testResults: [file("/repo/src/passing.test.ts", [assertion()])],
          },
        },
        {
          lane: "PostgreSQL integration",
          report: {
            testResults: [
              file("/repo/src/passing.db.test.ts", [assertion()]),
            ],
          },
        },
      ],
      "/repo",
    );

    expect(rendered).toContain("### Results by test file");
    expect(rendered).toContain("<code>src/passing.test.ts</code>");
    expect(rendered.indexOf("Unit &amp; coverage")).toBeLessThan(
      rendered.indexOf("PostgreSQL integration"),
    );
    expect(rendered).not.toContain("### Failed test cases");
  });

  it("renders failed errors as escaped, collapsible full details", () => {
    const rendered = renderVitestSummary(
      [
        {
          lane: "PostgreSQL integration",
          report: {
            testResults: [
              file("/repo/src/failing.db.test.ts", [
                assertion({
                  status: "failed",
                  fullName: "database > rejects unsafe <value>",
                  failureMessages: [
                    "AssertionError: expected <actual|value>\n    at test.ts:10:2",
                  ],
                }),
              ]),
            ],
          },
        },
      ],
      "/repo",
    );

    expect(rendered).toContain("### Failed test cases");
    expect(rendered).toContain("<details>");
    expect(rendered).toContain(
      "AssertionError: expected &lt;actual|value&gt;",
    );
    expect(rendered).toContain("at test.ts:10:2");
    expect(rendered).not.toContain("<actual|value>");
  });

  it("surfaces a setup or collection failure as a synthetic failed case", () => {
    const { files, failures } = summarizeVitestReports(
      [
        {
          lane: "Unit & coverage",
          report: {
            testResults: [
              file("/repo/src/collection.test.ts", [], {
                status: "failed",
                message: "Cannot import module",
              }),
            ],
          },
        },
      ],
      "/repo",
    );

    expect(files[0]).toMatchObject({ total: 1, failed: 1 });
    expect(failures[0]).toMatchObject({
      test: "Test file setup / collection",
      error: "Cannot import module",
    });
  });

  it("normalizes repository paths and formats durations", () => {
    expect(
      toRepositoryRelativePath(
        "C:\\repo\\src\\feature.test.ts",
        "C:\\repo",
      ),
    ).toBe("src/feature.test.ts");
    expect(formatDuration(855.4)).toBe("855ms");
    expect(formatDuration(62_009)).toBe("1m 2s 9ms");
  });

  it("rejects malformed JSON report structures", () => {
    expect(() =>
      parseVitestJsonReport({ testResults: "invalid" }, "unit.json"),
    ).toThrow("unit.json is missing a testResults array");
  });
});
