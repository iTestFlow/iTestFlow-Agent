import { describe, expect, it } from "vitest";

import { apiErrorMessage, caughtErrorMessage, responseErrorMessage } from "./api-error-message";

describe("api error message helpers", () => {
  it("reads friendly API envelopes", () => {
    expect(apiErrorMessage({ error: "Check your API key." }, "Fallback")).toBe("Check your API key.");
  });

  it("does not surface raw JSON payloads as the primary message", () => {
    expect(apiErrorMessage({ error: "{\"error\":{\"message\":\"API key not valid\"}}" }, "Fallback")).toBe("Fallback");
  });

  it("does not surface HTML errors from thrown Error objects", () => {
    expect(caughtErrorMessage(new Error("<html><body>Gateway timeout</body></html>"), "Fallback")).toBe("Fallback");
  });

  it("does not surface JSON parse syntax errors caused by HTML responses", () => {
    expect(caughtErrorMessage(new SyntaxError("Unexpected token '<', \"<!DOCTYPE html>\" is not valid JSON"), "Fallback")).toBe("Fallback");
  });

  it("does surface friendly messages that mention invalid JSON", () => {
    expect(caughtErrorMessage(
      new Error("The external LLM response was not valid JSON. Check the pasted response and try again."),
      "Fallback",
    )).toBe("The external LLM response was not valid JSON. Check the pasted response and try again.");
  });

  it("reads friendly messages from response envelopes", async () => {
    const response = new Response(JSON.stringify({ error: "Friendly" }), { status: 400 });

    await expect(responseErrorMessage(response, "Fallback")).resolves.toBe("Friendly");
  });
});
