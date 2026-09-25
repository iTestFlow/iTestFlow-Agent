import { createHash } from "node:crypto";
import { parseFragment } from "parse5";
import type { DefaultTreeAdapterMap } from "parse5";
import { AppError, AppErrorCode } from "@/modules/shared/errors/app-error";

export const ACCEPTANCE_CRITERIA_CONTRACT_VERSION = "1";

export type AcceptanceCriteriaContract = {
  version: string;
  sourceHash: string;
  criteria: Array<{ id: string; text: string }>;
};

export class AcceptanceCriteriaError extends AppError {
  constructor(
    code: AppErrorCode.AcceptanceCriteriaInvalidSource | AppErrorCode.AcceptanceCriteriaCoverage | AppErrorCode.AcceptanceCriteriaInputBudget | AppErrorCode.AcceptanceCriteriaDraftStale | AppErrorCode.AcceptanceCriteriaDraftInvalid,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super({ code, message, userMessage: message });
    this.name = "AcceptanceCriteriaError";
  }

  get status() {
    return this.code === AppErrorCode.AcceptanceCriteriaDraftStale ? 409
      : this.code === AppErrorCode.AcceptanceCriteriaDraftInvalid ? 403 : 422;
  }
}

type Node = DefaultTreeAdapterMap["node"];
type ParentNode = DefaultTreeAdapterMap["parentNode"];

const normalize = (text: string) => text.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
const ownText = (node: Node): string => {
  if ("value" in node && typeof node.value === "string") return node.value;
  if (!("childNodes" in node)) return "";
  return node.childNodes.map(ownText).join(" ");
};

function htmlBlocks(source: string): string[] {
  const root = parseFragment(source);
  const blocks: string[] = [];
  const visit = (node: Node, context = "") => {
    if (!("childNodes" in node)) {
      if ("value" in node) {
        const text = normalize(node.value);
        if (text) blocks.push(normalize([context, text].filter(Boolean).join(" — ")));
      }
      return;
    }
    const tag = "tagName" in node ? node.tagName : "";
    if (["table", "dl"].includes(tag)) {
      throw new AcceptanceCriteriaError(AppErrorCode.AcceptanceCriteriaInvalidSource,
        "The story's acceptance criteria contain a table or definition list that cannot be mapped safely. Rewrite the criteria as a numbered or bulleted list, then prepare a fresh prompt.");
    }
    if (tag === "li") {
      const direct = normalize(node.childNodes.filter((child) => !("tagName" in child && ["ul", "ol"].includes(child.tagName))).map(ownText).join(" "));
      const nested = node.childNodes.filter((child) => "tagName" in child && ["ul", "ol"].includes(child.tagName));
      if (nested.length) {
        for (const list of nested) for (const child of (list as ParentNode).childNodes) visit(child, normalize([context, direct].filter(Boolean).join(" — ")));
      } else if (direct) blocks.push(normalize([context, direct].filter(Boolean).join(" — ")));
      return;
    }
    if (["p", "div", "h1", "h2", "h3", "h4"].includes(tag)) {
      const direct = normalize(node.childNodes.filter((child) => !("tagName" in child && ["ul", "ol", "p", "div"].includes(child.tagName))).map(ownText).join(" "));
      if (direct) blocks.push(direct);
      for (const child of node.childNodes) if ("tagName" in child && ["ul", "ol", "p", "div"].includes(child.tagName)) visit(child, context);
      return;
    }
    for (const child of node.childNodes) visit(child, context);
  };
  for (const child of root.childNodes) {
    if ("value" in child) {
      const text = normalize(child.value);
      if (text) blocks.push(text);
    } else visit(child);
  }
  return blocks;
}

function plainBlockCriteria(block: string): string[] {
  const lines = block.split("\n").filter((line) => normalize(line));
  const marker = /^(?:[-*•]\s+|\d+[.)]\s+|AC[-\s]?\d+\s*[:.)-]\s*)(.*)$/i;
  if (!lines.some((line) => marker.test(line.trim()))) {
    const meaningful = lines.map((line) => normalize(line)).filter((line) => !/^(?:acceptance criteria|criteria)\s*:?$/i.test(line));
    const scenarioPattern = meaningful.some((line) => /^Scenario(?:\s+\d+)?\s*:/i.test(line))
      ? /^Scenario(?:\s+\d+)?\s*:/i : /^Given\b/i;
    const boundaryCount = meaningful.filter((line) => scenarioPattern.test(line)).length;
    if (boundaryCount > 1) {
      const scenarios: string[] = [];
      let current = "";
      let context = "";
      for (const line of meaningful) {
        if (scenarioPattern.test(line)) {
          if (current) scenarios.push(normalize([context, current].filter(Boolean).join(" — ")));
          current = line;
        } else if (current) current += ` ${line}`;
        else context = normalize([context, line].filter(Boolean).join(" "));
      }
      if (current) scenarios.push(normalize([context, current].filter(Boolean).join(" — ")));
      return scenarios;
    }
    const text = normalize(meaningful.join(" "));
    return text ? [text] : [];
  }
  const criteria: string[] = [];
  const stack: Array<{ indent: number; text: string; hasChildren: boolean }> = [];
  let context = "";
  const finish = () => {
    const entry = stack.pop();
    if (entry && !entry.hasChildren) {
      criteria.push(normalize([context, ...stack.map((parent) => parent.text), entry.text].filter(Boolean).join(" — ")));
    }
  };
  for (const line of lines) {
    const text = line.trim();
    if (/^(?:acceptance criteria|criteria)\s*:?$/i.test(text)) continue;
    const match = text.match(marker);
    if (match) {
      const indent = (line.match(/^[\t ]*/)?.[0] ?? "").replace(/\t/g, "  ").length;
      while (stack.length && indent <= stack[stack.length - 1].indent) finish();
      if (stack.length) stack[stack.length - 1].hasChildren = true;
      stack.push({ indent, text: normalize(match[1]), hasChildren: false });
    } else if (stack.length) {
      stack[stack.length - 1].text = normalize(`${stack[stack.length - 1].text} ${text}`);
    } else {
      context = normalize([context, text].filter(Boolean).join(" "));
    }
  }
  while (stack.length) finish();
  return criteria.length ? criteria : context ? [context] : [];
}

function extractCriteria(source: string): string[] {
  const html = /<\/?[a-z][^>]*>/i.test(source);
  const plainSource = source.replace(/\r\n?/g, "\n");
  const blocks = html ? htmlBlocks(source) : splitPlainBlocks(plainSource);
  const criteria: string[] = [];
  for (const block of blocks) {
    if (!html) {
      criteria.push(...plainBlockCriteria(block));
      continue;
    }
    const lines = block.split("\n").map(normalize).filter(Boolean);
    if (!lines.length) continue;
    const listed = lines.some((line) => /^(?:[-*•]\s+|\d+[.)]\s+|AC[-\s]?\d+\s*[:.)-]\s*)/i.test(line));
    if (!listed) {
      const text = normalize(lines.join(" "));
      if (text && !/^(?:acceptance criteria|criteria)\s*:?$/i.test(text)) criteria.push(text);
      continue;
    }
    let commonContext = "";
    let current = "";
    for (const line of lines) {
      if (/^(?:acceptance criteria|criteria)\s*:?$/i.test(line)) continue;
      const match = line.match(/^(?:[-*•]\s+|\d+[.)]\s+|AC[-\s]?\d+\s*[:.)-]\s*)(.*)$/i);
      if (match) {
        if (current) criteria.push(normalize([commonContext, current].filter(Boolean).join(" — ")));
        current = match[1];
      } else if (current) {
        current = `${current} ${line}`;
      } else {
        commonContext = normalize([commonContext, line].filter(Boolean).join(" "));
      }
    }
    if (current) criteria.push(normalize([commonContext, current].filter(Boolean).join(" — ")));
    else if (commonContext) criteria.push(commonContext);
  }
  // Given/When/Then lines form a single scenario, including And/But clauses.
  const grouped: string[] = [];
  for (const text of criteria) {
    if (/^Given\b/i.test(text) && grouped.length && /^Scenario(?:\s+\d+)?\s*:/i.test(grouped[grouped.length - 1])) {
      grouped[grouped.length - 1] += ` ${text}`;
    } else if (/^(?:When|Then|And|But)\b/i.test(text) && grouped.length && /\bGiven\b/i.test(grouped[grouped.length - 1])) {
      grouped[grouped.length - 1] += ` ${text}`;
    } else grouped.push(text);
  }
  return grouped.filter(Boolean);
}

function splitPlainBlocks(source: string): string[] {
  const lines = source.split("\n");
  const blocks: string[] = [];
  let current: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (normalize(line)) {
      current.push(line);
      continue;
    }
    let next = index + 1;
    while (next < lines.length && !normalize(lines[next])) next += 1;
    const nextLine = lines[next] ?? "";
    const isIndentedListItem = /^\s+\s*(?:[-*•]\s+|\d+[.)]\s+|AC[-\s]?\d+\s*[:.)-]\s*)/i.test(nextLine);
    if (isIndentedListItem) {
      current.push("");
    } else if (current.some(normalize)) {
      blocks.push(current.join("\n"));
      current = [];
    }
    index = next - 1;
  }
  if (current.some(normalize)) blocks.push(current.join("\n"));
  return blocks;
}

export function buildAcceptanceCriteriaContract(story: unknown): AcceptanceCriteriaContract {
  const item = story && typeof story === "object" ? story as Record<string, unknown> : {};
  const source = typeof item.acceptanceCriteria === "string" ? item.acceptanceCriteria : "";
  const title = typeof item.title === "string" ? item.title : "";
  const description = typeof item.description === "string" ? item.description : "";
  const criteria = extractCriteria(source);
  if (!criteria.length || (normalize(source) && !normalize(criteria.join(" ")))) {
    throw new AcceptanceCriteriaError(AppErrorCode.AcceptanceCriteriaInvalidSource, "The selected story has no readable acceptance criteria. Add or clarify its acceptance criteria, then prepare the prompt again.");
  }
  const sourceHash = createHash("sha256")
    .update(JSON.stringify([ACCEPTANCE_CRITERIA_CONTRACT_VERSION, normalize(title), normalize(description), normalize(source)]))
    .digest("hex");
  return {
    version: ACCEPTANCE_CRITERIA_CONTRACT_VERSION,
    sourceHash,
    criteria: criteria.map((text, index) => ({ id: `AC-${String(index + 1).padStart(3, "0")}`, text })),
  };
}
