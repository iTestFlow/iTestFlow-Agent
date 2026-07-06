// Display-label parsers for the topbar LLM status chip. Pure string logic
// extracted from topbar.tsx so it can be unit tested outside the client component.

export type Provider = "openai" | "gemini" | "anthropic"

export function providerLabel(value?: string | null) {
  switch (value) {
    case "openai":
      return "OpenAI"
    case "gemini":
      return "Gemini"
    case "anthropic":
      return "Anthropic"
    default:
      return value ? value : "LLM"
  }
}

export function isProvider(value?: string | null): value is Provider {
  return value === "openai" || value === "gemini" || value === "anthropic"
}

export function humanizeModelId(model: string, provider?: string | null) {
  const vendorPrefixes: Record<string, RegExp> = {
    gemini: /^gemini[-_]/i,
    anthropic: /^claude[-_]/i,
    openai: /^openai[-_]/i,
  }
  const modelName = (model.split("/").pop() ?? model)
    .replace(provider ? vendorPrefixes[provider] ?? /$^/ : /$^/, "")
    .split(/[-_]+/)
    .filter((part) => part && !/^\d{8}$/.test(part) && part.toLocaleLowerCase() !== "latest")
    .slice(0, 4)
    .map((part) => {
      if (/^gpt$/i.test(part)) return "GPT"
      if (/^[a-z]\d+$/i.test(part) || /^\d+(?:\.\d+)*$/.test(part)) return part
      return `${part.charAt(0).toLocaleUpperCase()}${part.slice(1)}`
    })
    .join(" ")

  return modelName || "Model"
}

export function modelDisplayLabel(provider?: string | null, model?: string | null) {
  const providerName = providerLabel(provider)
  const normalizedModel = model?.toLocaleLowerCase() ?? ""

  if (provider === "gemini") {
    if (normalizedModel.includes("flash-lite")) return "Gemini: Flash Lite"
    if (normalizedModel.includes("flash")) return "Gemini: Flash"
    if (normalizedModel.includes("pro")) return "Gemini: Pro"
    return model ? `Gemini: ${humanizeModelId(model, provider)}` : "Gemini"
  }

  if (provider === "anthropic") {
    if (normalizedModel.includes("haiku")) return "Claude: Haiku"
    if (normalizedModel.includes("sonnet")) return "Claude: Sonnet"
    if (normalizedModel.includes("opus")) return "Claude: Opus"
    return model ? `Claude: ${humanizeModelId(model, provider)}` : "Claude"
  }

  if (provider === "openai") {
    const conciseModel = model?.match(/^(gpt-[\w.]+|o\d(?:-[\w.]+)?)/i)?.[1]
    if (conciseModel) return `${providerName}: ${humanizeModelId(conciseModel, provider)}`
    return model ? `${providerName}: ${humanizeModelId(model, provider)}` : providerName
  }

  return model ? `${providerName}: ${humanizeModelId(model, provider)}` : providerName
}
