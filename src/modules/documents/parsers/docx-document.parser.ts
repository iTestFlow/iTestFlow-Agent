import mammoth from "mammoth";

import {
  DocumentParseError,
  type DocumentParseInput,
  type DocumentParser,
  type ParsedDocument,
  type ParsedDocumentSection,
  type ParsedDocumentWarning,
} from "../parsed-document.types";
import {
  assertNotAborted,
  assertWithinExtractedTextLimit,
  createNoTextWarning,
  createParsedDocument,
  normalizeExtractedText,
  paragraphSections,
} from "./parser-utils";

/**
 * Mammoth's own default style map already maps the Heading1-6 paragraph
 * styles (by style ID and by style name) to h1-h6. This explicit map is kept
 * alongside the default so heading recognition stays documented and stable
 * even if a future mammoth release trims what it maps by default.
 */
const HEADING_STYLE_MAP = [
  "p[style-name='Heading 1'] => h1:fresh",
  "p[style-name='Heading 2'] => h2:fresh",
  "p[style-name='Heading 3'] => h3:fresh",
  "p[style-name='Heading 4'] => h4:fresh",
  "p[style-name='Heading 5'] => h5:fresh",
  "p[style-name='Heading 6'] => h6:fresh",
];

export const docxDocumentParser: DocumentParser = {
  format: "docx",

  async parse(input) {
    assertNotAborted(input.signal);
    const buffer = Buffer.from(input.data);

    let html: string;
    let messages: MammothMessage[];
    try {
      // Mammoth extracts structure from OOXML only; it does not execute
      // macros or render document content. ZIP/macro guards run before this
      // parser. convertToHtml (rather than extractRawText) is what lets us
      // recover heading boundaries instead of flat paragraph text.
      const result = await mammoth.convertToHtml({ buffer }, { styleMap: HEADING_STYLE_MAP });
      html = result.value;
      messages = result.messages;
    } catch (error) {
      // Heading-structured conversion failed; a flat parse is still better
      // than failing the whole document, so fall back rather than throwing.
      return parseRawTextFallback(buffer, input, error);
    }
    assertNotAborted(input.signal);

    try {
      const sections = htmlToSections(html);
      assertWithinExtractedTextLimit(sections.map((section) => section.text).join("\n"), input.maxExtractedTextChars);

      const warnings = messages.map(toParserWarning);
      if (sections.length === 0) warnings.push(createNoTextWarning());

      return createParsedDocument({ format: "docx", sections, warnings });
    } catch (error) {
      if (error instanceof DocumentParseError) throw error;
      throw documentParseError(error);
    }
  },
};

async function parseRawTextFallback(
  buffer: Buffer,
  input: DocumentParseInput,
  conversionError: unknown,
): Promise<ParsedDocument> {
  try {
    const result = await mammoth.extractRawText({ buffer });
    assertNotAborted(input.signal);

    const text = normalizeExtractedText(result.value);
    assertWithinExtractedTextLimit(text, input.maxExtractedTextChars);
    const sections = paragraphSections({ text, metadata: { origin: "document_text" } });

    const warnings = result.messages.map(toParserWarning);
    warnings.push({
      code: "parser_message",
      message: "Heading structure could not be parsed; falling back to flat paragraph text.",
      metadata: {
        severity: "warning",
        cause: conversionError instanceof Error ? conversionError.message : String(conversionError),
      },
    });
    if (sections.length === 0) warnings.push(createNoTextWarning());

    return createParsedDocument({ format: "docx", sections, warnings });
  } catch (error) {
    if (error instanceof DocumentParseError) throw error;
    throw documentParseError(error);
  }
}

type MammothMessage = { type: "warning" | "error"; message: string };

/**
 * Walks the constrained tag set mammoth's HTML output uses (h1-h6, p, li,
 * table/tr/td/th, plus inline formatting tags) with a small tolerant state
 * machine rather than a full HTML parser. Every tag is stripped so section
 * text is always plain text; headings start a new section the same way the
 * Markdown parser's ATX headings do.
 */
function htmlToSections(html: string): ParsedDocumentSection[] {
  const sections: ParsedDocumentSection[] = [];
  const keyCounts = new Map<string, number>();

  const preambleLines: string[] = [];
  let headingLines: string[] = [];
  let currentHeading: { title: string; level: number } | undefined;

  let blockText = "";
  let headingText = "";
  let headingLevel: number | undefined;
  let cells: string[] = [];

  const destination = () => (currentHeading ? headingLines : preambleLines);

  const commitLine = (raw: string) => {
    const line = collapseWhitespace(decodeHtmlEntities(raw));
    if (line) destination().push(line);
  };

  const flushHeading = () => {
    if (!currentHeading) return;
    const body = headingLines.join("\n\n").trim();
    const baseKey = `heading-${headingSlug(currentHeading.title)}`;
    const count = (keyCounts.get(baseKey) ?? 0) + 1;
    keyCounts.set(baseKey, count);
    sections.push({
      sectionKey: count === 1 ? baseKey : `${baseKey}-${count}`,
      kind: "heading",
      text: body ? `${currentHeading.title}\n\n${body}` : currentHeading.title,
      metadata: {
        origin: "document_text",
        heading: currentHeading.title,
        headingLevel: currentHeading.level,
      },
    });
    headingLines = [];
  };

  const handleTag = (tag: string) => {
    const match = /^<\/?([a-zA-Z0-9]+)/.exec(tag);
    if (!match) return;
    const name = match[1].toLowerCase();
    const closing = tag.startsWith("</");

    if (/^h[1-6]$/.test(name)) {
      if (closing) {
        currentHeading = { title: collapseWhitespace(decodeHtmlEntities(headingText)), level: headingLevel ?? currentHeading?.level ?? 1 };
        headingLevel = undefined;
      } else {
        commitLine(blockText);
        blockText = "";
        flushHeading();
        headingLevel = Number(name[1]);
        headingText = "";
      }
      return;
    }

    if (name === "br") {
      if (headingLevel) headingText += " ";
      else blockText += " ";
      return;
    }

    if (name === "td" || name === "th") {
      if (closing) {
        cells.push(collapseWhitespace(decodeHtmlEntities(blockText)));
        blockText = "";
      }
      return;
    }

    if (name === "tr") {
      if (!closing) {
        cells = [];
      } else {
        const line = cells.filter(Boolean).join(" | ");
        if (line) destination().push(line);
        cells = [];
      }
      return;
    }

    if (name === "p" || name === "li") {
      if (closing) {
        commitLine(blockText);
        blockText = "";
      }
      return;
    }

    // table/ul/ol and inline formatting tags (strong/em/a/img/span/...) carry
    // no text of their own; strip the tag and let surrounding text flow on.
  };

  let index = 0;
  while (index < html.length) {
    const tagStart = html.indexOf("<", index);
    if (tagStart === -1) {
      appendText(html.slice(index));
      break;
    }
    if (tagStart > index) appendText(html.slice(index, tagStart));
    const tagEnd = html.indexOf(">", tagStart);
    if (tagEnd === -1) break; // Unterminated tag in a truncated tail; stop tolerantly.
    handleTag(html.slice(tagStart, tagEnd + 1));
    index = tagEnd + 1;
  }

  function appendText(raw: string) {
    if (!raw) return;
    if (headingLevel) headingText += raw;
    else blockText += raw;
  }

  commitLine(blockText);
  flushHeading();

  const preambleSections =
    preambleLines.length > 0
      ? paragraphSections({ text: preambleLines.join("\n\n"), metadata: { origin: "document_text" } })
      : [];

  return [...preambleSections, ...sections];
}

const NAMED_HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeHtmlEntities(value: string) {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity[0] === "#") {
      const isHex = entity[1] === "x" || entity[1] === "X";
      const codePoint = Number.parseInt(isHex ? entity.slice(2) : entity.slice(1), isHex ? 16 : 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    return NAMED_HTML_ENTITIES[entity] ?? match;
  });
}

function collapseWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

/** Mirrors the Markdown parser's slug so DOCX and MD heading provenance line up. */
function headingSlug(value: string) {
  const slug = value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "untitled";
}

function toParserWarning(message: MammothMessage): ParsedDocumentWarning {
  return {
    code: "parser_message",
    message: message.message.slice(0, 1_000),
    metadata: { severity: message.type },
  };
}

function documentParseError(error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown DOCX parsing failure.";
  if (/password|encrypt/i.test(message)) {
    return new DocumentParseError({
      code: "password_protected",
      message: "Password-protected DOCX files are not supported.",
      cause: error,
    });
  }
  return new DocumentParseError({
    code: "corrupted",
    message: "The DOCX file could not be parsed.",
    cause: error,
  });
}
