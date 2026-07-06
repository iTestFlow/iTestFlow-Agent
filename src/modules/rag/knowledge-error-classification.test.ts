import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  isInvalidKnowledgeBaseOutputError,
  isTruncatedKnowledgeBaseOutputError,
} from "@/modules/rag/knowledge-error-classification";

describe("isTruncatedKnowledgeBaseOutputError", () => {
  it.each([
    "Response exceeded the max output token limit.",
    "The output token budget was exhausted mid-generation.",
    // finishReason must precede MAX_TOKENS for the third alternative to match.
    'Generation stopped: finishReason was "MAX_TOKENS".',
    // Signature matching is case-insensitive.
    "MAX OUTPUT TOKEN cap reached",
  ])("classifies %j as truncated", (message) => {
    expect(isTruncatedKnowledgeBaseOutputError(new Error(message))).toBe(true);
  });

  it("does not classify MAX_TOKENS without a finishReason prefix", () => {
    expect(isTruncatedKnowledgeBaseOutputError(new Error("stopped due to MAX_TOKENS"))).toBe(false);
  });

  it("requires an Error instance, not just a message-shaped value", () => {
    expect(isTruncatedKnowledgeBaseOutputError("max output token limit")).toBe(false);
    expect(isTruncatedKnowledgeBaseOutputError({ message: "token budget exceeded" })).toBe(false);
  });
});

describe("isInvalidKnowledgeBaseOutputError", () => {
  it("classifies ZodError and SyntaxError instances regardless of message", () => {
    expect(isInvalidKnowledgeBaseOutputError(new z.ZodError([]))).toBe(true);
    expect(isInvalidKnowledgeBaseOutputError(new SyntaxError("Unexpected end of input"))).toBe(true);
  });

  it.each([
    "Model returned malformed JSON.",
    "Failed to parse structured output.",
    "Validation failed for knowledge base draft.",
    "Output did not match the expected SCHEMA.",
  ])("classifies %j as invalid output", (message) => {
    expect(isInvalidKnowledgeBaseOutputError(new Error(message))).toBe(true);
  });

  it("requires an Error instance for message-based matching", () => {
    expect(isInvalidKnowledgeBaseOutputError("json parse failure")).toBe(false);
    expect(isInvalidKnowledgeBaseOutputError(undefined)).toBe(false);
  });
});

describe("classification boundaries", () => {
  it("leaves unrelated errors and non-errors unclassified", () => {
    for (const error of [new Error("Network unreachable"), new Error("boom"), null, 42]) {
      expect(isTruncatedKnowledgeBaseOutputError(error)).toBe(false);
      expect(isInvalidKnowledgeBaseOutputError(error)).toBe(false);
    }
  });

  it("can match both classifiers at once, so callers must check truncated first", () => {
    const error = new Error("token budget exhausted while emitting JSON");
    expect(isTruncatedKnowledgeBaseOutputError(error)).toBe(true);
    expect(isInvalidKnowledgeBaseOutputError(error)).toBe(true);
  });
});
