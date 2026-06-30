import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type VitestAssertionStatus =
  | "passed"
  | "failed"
  | "skipped"
  | "pending"
  | "todo"
  | "disabled";

export interface VitestAssertionResult {
  ancestorTitles: string[];
  fullName: string;
  status: VitestAssertionStatus;
  title: string;
  duration?: number | null;
  failureMessages: string[] | null;
}

export interface VitestFileResult {
  assertionResults: VitestAssertionResult[];
  endTime: number;
  message: string;
  name: string;
  startTime: number;
  status: "failed" | "passed";
}

export interface VitestJsonReport {
  testResults: VitestFileResult[];
}

export interface LaneReport {
  lane: string;
  report: VitestJsonReport;
}

export interface TestFileSummary {
  failed: number;
  file: string;
  lane: string;
  passed: number;
  skipped: number;
  timeMs: number;
  total: number;
}

export interface FailedTestSummary {
  error: string;
  errorSummary: string;
  file: string;
  lane: string;
  test: string;
  timeMs: number;
}

const REPORT_FILES = [
  { lane: "Unit & coverage", reportPath: "reports/unit.json" },
  {
    lane: "PostgreSQL integration",
    reportPath: "reports/integration.json",
  },
] as const;

const ANSI_ESCAPE_PATTERN = /\u001B\[[0-?]*[ -/]*[@-~]/g;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseVitestJsonReport(
  value: unknown,
  source = "Vitest JSON report",
): VitestJsonReport {
  if (!isRecord(value) || !Array.isArray(value.testResults)) {
    throw new Error(`${source} is missing a testResults array.`);
  }

  for (const [fileIndex, file] of value.testResults.entries()) {
    if (
      !isRecord(file) ||
      typeof file.name !== "string" ||
      typeof file.startTime !== "number" ||
      typeof file.endTime !== "number" ||
      (file.status !== "passed" && file.status !== "failed") ||
      !Array.isArray(file.assertionResults)
    ) {
      throw new Error(`${source} has an invalid test result at index ${fileIndex}.`);
    }

    for (const [assertionIndex, assertion] of file.assertionResults.entries()) {
      if (
        !isRecord(assertion) ||
        typeof assertion.title !== "string" ||
        typeof assertion.fullName !== "string" ||
        typeof assertion.status !== "string" ||
        !Array.isArray(assertion.ancestorTitles) ||
        !(
          assertion.failureMessages === null ||
          Array.isArray(assertion.failureMessages)
        )
      ) {
        throw new Error(
          `${source} has an invalid assertion at file ${fileIndex}, assertion ${assertionIndex}.`,
        );
      }
    }
  }

  return value as unknown as VitestJsonReport;
}

export function toRepositoryRelativePath(
  filePath: string,
  repositoryRoot: string,
): string {
  const normalizedFile = filePath.replaceAll("\\", "/");
  const normalizedRoot = repositoryRoot.replaceAll("\\", "/").replace(/\/+$/, "");
  const caseInsensitive = /^[A-Za-z]:\//.test(normalizedRoot);
  const comparableFile = caseInsensitive
    ? normalizedFile.toLowerCase()
    : normalizedFile;
  const comparableRoot = caseInsensitive
    ? normalizedRoot.toLowerCase()
    : normalizedRoot;

  if (comparableFile.startsWith(`${comparableRoot}/`)) {
    return normalizedFile.slice(normalizedRoot.length + 1);
  }

  const relative = path.relative(repositoryRoot, filePath).replaceAll("\\", "/");
  if (relative && relative !== ".." && !relative.startsWith("../")) {
    return relative;
  }

  return normalizedFile;
}

function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE_PATTERN, "");
}

function failureText(assertion: VitestAssertionResult): string {
  const messages =
    assertion.failureMessages?.map(stripAnsi).filter((message) => message.trim()) ??
    [];
  return messages.length > 0
    ? messages.join("\n\n")
    : "Test failed without an error message.";
}

function firstErrorLine(error: string): string {
  return (
    error
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? "Test failed"
  );
}

function testName(assertion: VitestAssertionResult): string {
  if (assertion.fullName.trim()) {
    return assertion.fullName.trim();
  }
  return [...assertion.ancestorTitles, assertion.title]
    .filter(Boolean)
    .join(" > ");
}

export function summarizeVitestReports(
  laneReports: LaneReport[],
  repositoryRoot = process.cwd(),
): {
  failures: FailedTestSummary[];
  files: TestFileSummary[];
} {
  const files: TestFileSummary[] = [];
  const failures: FailedTestSummary[] = [];
  const laneOrder = new Map(
    laneReports.map(({ lane }, index) => [lane, index]),
  );

  for (const { lane, report } of laneReports) {
    for (const fileResult of report.testResults) {
      const file = toRepositoryRelativePath(fileResult.name, repositoryRoot);
      let passed = 0;
      let skipped = 0;
      let failed = 0;

      for (const assertion of fileResult.assertionResults) {
        if (assertion.status === "passed") {
          passed += 1;
        } else if (assertion.status === "failed") {
          failed += 1;
          const error = failureText(assertion);
          failures.push({
            lane,
            file,
            test: testName(assertion),
            error,
            errorSummary: firstErrorLine(error),
            timeMs: assertion.duration ?? 0,
          });
        } else {
          skipped += 1;
        }
      }

      // A setup/collection failure can fail a file before Vitest creates a failed
      // assertion. Surface it as one synthetic case instead of showing a green row.
      if (fileResult.status === "failed" && failed === 0) {
        failed = 1;
        const error =
          stripAnsi(fileResult.message).trim() ||
          "Test file failed during setup or collection.";
        failures.push({
          lane,
          file,
          test: "Test file setup / collection",
          error,
          errorSummary: firstErrorLine(error),
          timeMs: 0,
        });
      }

      files.push({
        lane,
        file,
        total: passed + skipped + failed,
        passed,
        skipped,
        failed,
        timeMs: Math.max(0, fileResult.endTime - fileResult.startTime),
      });
    }
  }

  files.sort(
    (left, right) =>
      (laneOrder.get(left.lane) ?? Number.MAX_SAFE_INTEGER) -
        (laneOrder.get(right.lane) ?? Number.MAX_SAFE_INTEGER) ||
      left.file.localeCompare(right.file),
  );
  failures.sort(
    (left, right) =>
      (laneOrder.get(left.lane) ?? Number.MAX_SAFE_INTEGER) -
        (laneOrder.get(right.lane) ?? Number.MAX_SAFE_INTEGER) ||
      left.file.localeCompare(right.file) ||
      left.test.localeCompare(right.test),
  );

  return { files, failures };
}

export function formatDuration(milliseconds: number): string {
  const rounded = Math.max(0, Math.round(milliseconds));
  const minutes = Math.floor(rounded / 60_000);
  const seconds = Math.floor((rounded % 60_000) / 1_000);
  const remainingMilliseconds = rounded % 1_000;
  const parts: string[] = [];

  if (minutes > 0) {
    parts.push(`${minutes}m`);
  }
  if (seconds > 0) {
    parts.push(`${seconds}s`);
  }
  if (remainingMilliseconds > 0 || parts.length === 0) {
    parts.push(`${remainingMilliseconds}ms`);
  }

  return parts.join(" ");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderFileTable(files: TestFileSummary[]): string {
  const rows = files.map(
    (file) =>
      [
        "<tr>",
        `<td>${escapeHtml(file.lane)}</td>`,
        `<td><code>${escapeHtml(file.file)}</code></td>`,
        `<td>${file.total}</td>`,
        `<td>${file.passed}</td>`,
        `<td>${file.skipped}</td>`,
        `<td>${file.failed}</td>`,
        `<td>${formatDuration(file.timeMs)}</td>`,
        "</tr>",
      ].join(""),
  );

  return [
    "### Results by test file",
    "",
    "<table>",
    "<thead><tr><th>Lane</th><th>Test file</th><th>Tests</th><th>Passed</th><th>Skipped</th><th>Failed</th><th>Time</th></tr></thead>",
    `<tbody>${rows.join("")}</tbody>`,
    "</table>",
  ].join("\n");
}

function renderFailureTable(failures: FailedTestSummary[]): string {
  const rows = failures.map(
    (failure) =>
      [
        "<tr>",
        `<td>${escapeHtml(failure.lane)}</td>`,
        `<td><code>${escapeHtml(failure.file)}</code></td>`,
        `<td>${escapeHtml(failure.test)}</td>`,
        "<td>",
        `<details><summary><code>${escapeHtml(failure.errorSummary)}</code></summary>`,
        `<pre>${escapeHtml(failure.error)}</pre>`,
        "</details>",
        "</td>",
        `<td>${formatDuration(failure.timeMs)}</td>`,
        "</tr>",
      ].join(""),
  );

  return [
    "### Failed test cases",
    "",
    "<table>",
    "<thead><tr><th>Lane</th><th>Test file</th><th>Test</th><th>Error</th><th>Time</th></tr></thead>",
    `<tbody>${rows.join("")}</tbody>`,
    "</table>",
  ].join("\n");
}

export function renderVitestSummary(
  laneReports: LaneReport[],
  repositoryRoot = process.cwd(),
): string {
  const { files, failures } = summarizeVitestReports(
    laneReports,
    repositoryRoot,
  );
  const sections = [renderFileTable(files)];

  if (failures.length > 0) {
    sections.push(renderFailureTable(failures));
  }

  return sections.join("\n\n");
}

async function loadLaneReports(): Promise<LaneReport[]> {
  return Promise.all(
    REPORT_FILES.map(async ({ lane, reportPath }) => {
      const raw = await readFile(reportPath, "utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        throw new Error(
          `${reportPath} is not valid JSON: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      return {
        lane,
        report: parseVitestJsonReport(parsed, reportPath),
      };
    }),
  );
}

async function main(): Promise<void> {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    throw new Error("GITHUB_STEP_SUMMARY is required.");
  }

  const laneReports = await loadLaneReports();
  const summary = renderVitestSummary(laneReports);
  await appendFile(summaryPath, `\n${summary}\n`, "utf8");
}

const entryPoint = process.argv[1]
  ? path.resolve(process.argv[1])
  : undefined;

if (entryPoint === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
