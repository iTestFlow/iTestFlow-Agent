import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_MAX_OUTPUT_TOKEN_CAP,
  getMaxOutputTokenCapDefaultFromEnv,
} from "@/modules/llm/llm-defaults";
import {
  clampTopK,
  DEFAULT_TOP_K,
  getRetrievalTopKFromEnv,
} from "@/modules/rag/retrieval-config";

describe("workspace setting defaults", () => {
  afterEach(() => {
    delete process.env.PROJECT_CONTEXT_TOP_K;
    delete process.env.LLM_MAX_OUTPUT_TOKEN_CAP;
  });

  it("clamps retrieval limits", () => {
    expect(clampTopK(0)).toBe(1);
    expect(clampTopK(1000)).toBe(25);
    expect(clampTopK(12)).toBe(12);
    expect(clampTopK(Number.NaN)).toBe(DEFAULT_TOP_K);
  });

  it("reads PROJECT_CONTEXT_TOP_K from the environment with a clamped default", () => {
    process.env.PROJECT_CONTEXT_TOP_K = "15";
    expect(getRetrievalTopKFromEnv()).toBe(15);
    delete process.env.PROJECT_CONTEXT_TOP_K;
    expect(getRetrievalTopKFromEnv()).toBe(DEFAULT_TOP_K);
    process.env.PROJECT_CONTEXT_TOP_K = "999";
    expect(getRetrievalTopKFromEnv()).toBe(25);
  });

  it("reads LLM_MAX_OUTPUT_TOKEN_CAP from the environment with allowed-option defaults", () => {
    process.env.LLM_MAX_OUTPUT_TOKEN_CAP = "64000";
    expect(getMaxOutputTokenCapDefaultFromEnv()).toBe(64000);
    delete process.env.LLM_MAX_OUTPUT_TOKEN_CAP;
    expect(getMaxOutputTokenCapDefaultFromEnv()).toBe(DEFAULT_MAX_OUTPUT_TOKEN_CAP);
    process.env.LLM_MAX_OUTPUT_TOKEN_CAP = "not-a-number";
    expect(getMaxOutputTokenCapDefaultFromEnv()).toBe(DEFAULT_MAX_OUTPUT_TOKEN_CAP);
    process.env.LLM_MAX_OUTPUT_TOKEN_CAP = "999";
    expect(getMaxOutputTokenCapDefaultFromEnv()).toBe(16000);
    process.env.LLM_MAX_OUTPUT_TOKEN_CAP = "100000";
    expect(getMaxOutputTokenCapDefaultFromEnv()).toBe(64000);
  });
});
