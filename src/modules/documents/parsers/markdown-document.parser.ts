import type { DocumentParser, ParsedDocumentSection } from "../parsed-document.types";
import {
  assertNotAborted,
  assertWithinExtractedTextLimit,
  createNoTextWarning,
  createParsedDocument,
  decodeTextBytes,
  normalizeExtractedText,
  paragraphSections,
} from "./parser-utils";

export const markdownDocumentParser: DocumentParser = {
  format: "md",

  async parse(input) {
    assertNotAborted(input.signal);
    const text = normalizeExtractedText(decodeTextBytes(input.data));
    assertWithinExtractedTextLimit(text, input.maxExtractedTextChars);
    assertNotAborted(input.signal);

    const sections = markdownSections(text);
    return createParsedDocument({
      format: "md",
      sections,
      warnings: sections.length === 0 ? [createNoTextWarning()] : [],
    });
  },
};

function markdownSections(text: string): ParsedDocumentSection[] {
  if (!text) return [];

  const sections: ParsedDocumentSection[] = [];
  const lines = text.split("\n");
  let currentLines: string[] = [];
  let currentHeading: { title: string; level: number } | undefined;
  let inCodeFence = false;
  const keyCounts = new Map<string, number>();

  const flush = () => {
    const body = currentLines.join("\n").trim();
    if (!body) {
      currentLines = [];
      return;
    }

    if (!currentHeading) {
      const paragraphGroups = paragraphSections({
        text: body,
        sectionPrefix: "paragraph",
        metadata: { origin: "document_text" },
      });
      sections.push(...paragraphGroups);
    } else {
      const baseKey = `heading-${headingSlug(currentHeading.title)}`;
      const count = (keyCounts.get(baseKey) ?? 0) + 1;
      keyCounts.set(baseKey, count);
      sections.push({
        sectionKey: count === 1 ? baseKey : `${baseKey}-${count}`,
        kind: "heading",
        text: body,
        metadata: {
          origin: "document_text",
          heading: currentHeading.title,
          headingLevel: currentHeading.level,
        },
      });
    }
    currentLines = [];
  };

  for (const line of lines) {
    if (isFence(line)) inCodeFence = !inCodeFence;
    const heading = !inCodeFence ? parseAtxHeading(line) : undefined;
    if (heading) {
      flush();
      currentHeading = heading;
      currentLines = [line];
      continue;
    }
    currentLines.push(line);
  }
  flush();

  return sections;
}

function parseAtxHeading(line: string) {
  const match = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
  if (!match) return undefined;
  return { level: match[1].length, title: match[2].trim() };
}

function isFence(line: string) {
  return /^\s{0,3}(?:`{3,}|~{3,})/.test(line);
}

function headingSlug(value: string) {
  const slug = value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "untitled";
}
