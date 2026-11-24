import "server-only";

import { OpenAIProvider } from "./openai-provider";

export const XAI_DEFAULT_BASE_URL = "https://api.x.ai/v1";

/**
 * xAI (Grok) exposes an OpenAI-compatible chat-completions API at https://api.x.ai/v1, including
 * `response_format: json_schema`, function tools and `tool_choice: "required"`. This provider reuses
 * the OpenAI request/response handling and only changes the default endpoint and the label shown in
 * errors, so xAI failures read "xAI request failed" instead of pointing at OpenAI.
 */
export class XAIProvider extends OpenAIProvider {
  protected override get defaultBaseUrl(): string {
    return XAI_DEFAULT_BASE_URL;
  }

  protected override get providerLabel(): string {
    return "xAI";
  }
}
