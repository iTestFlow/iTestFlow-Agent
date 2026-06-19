import { AppErrorCode } from "@/modules/shared/errors/app-error";

/** Friendly, user-facing message for an error. Raw text is kept as technical detail. */
export function mapFriendlyError(input?: { code?: AppErrorCode; raw?: string | null } | string | null): string {
  const raw = typeof input === "string" || input === null ? input : input?.raw;
  const code = typeof input === "object" && input !== null ? input.code : undefined;
  switch (code) {
    case AppErrorCode.TokenLimit:
      return 'The AI response ran out of output space before it finished. Increase the "Maximum output token cap" in Settings and retry.';
    case AppErrorCode.InvalidJson:
      return "The AI response was not valid JSON. Please retry the generation.";
    case AppErrorCode.SchemaValidation:
      return "The AI returned a response that did not match the expected format. Please retry or adjust the input.";
    case AppErrorCode.ProviderUnavailable:
      return "The AI provider could not complete the request. Please try again in a moment or check the provider settings.";
    case AppErrorCode.NoProvider:
      return "No LLM provider is configured. Configure a provider, model, and API key in Settings.";
    case AppErrorCode.Network:
      return "Network error. Check your connection and try again.";
    case AppErrorCode.Unknown:
      return "The AI response could not be completed. You can retry or adjust the input.";
    default:
      break;
  }

  const text = (raw ?? "").toLowerCase();
  if (!text) return "The AI response could not be completed. You can retry or adjust the input.";
  if (text.includes("output-token limit") || text.includes("maximum output token") || text.includes("max_tokens")) {
    return 'The AI response ran out of output space before it finished. Increase the "Maximum output token cap" in Settings and retry.';
  }
  if (text.includes("503") || text.includes("overloaded") || text.includes("unavailable") || text.includes("no llm provider")) {
    return "The AI provider is temporarily unavailable. Please try again in a moment.";
  }
  if (text.includes("failed to fetch") || text.includes("networkerror") || text.includes("network error")) {
    return "Network error. Check your connection and try again.";
  }
  if (text.includes("invalid json") || text.includes("non-json")) {
    return "The server returned an unexpected response. Please try again.";
  }
  if (text.includes("schema") || text.includes("validation") || text.includes("400") || text.includes("422")) {
    return "The AI returned a response that didn't match the expected format. You can retry or adjust the input.";
  }
  return "The AI response could not be completed. You can retry or adjust the input.";
}
