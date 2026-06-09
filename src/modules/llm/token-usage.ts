import type { TokenUsage } from "./llm-types";

export function addTokenUsage(current?: TokenUsage, next?: TokenUsage): TokenUsage | undefined {
  if (!next) return current;

  const input = addOptionalCounts(current?.input, next.input);
  const output = addOptionalCounts(current?.output, next.output);
  const total = addOptionalCounts(current?.total, next.total)
    ?? (input !== undefined && output !== undefined ? input + output : undefined);

  return { input, output, total };
}

export function hasTokenUsage(tokenUsage?: TokenUsage) {
  return [tokenUsage?.input, tokenUsage?.output, tokenUsage?.total]
    .some((value) => typeof value === "number" && Number.isFinite(value));
}

function addOptionalCounts(current?: number, next?: number) {
  if (current === undefined && next === undefined) return undefined;
  return (current ?? 0) + (next ?? 0);
}
