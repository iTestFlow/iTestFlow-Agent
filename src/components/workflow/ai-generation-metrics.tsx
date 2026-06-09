import type { TokenUsage } from "@/modules/llm/llm-types";
import { cn } from "@/lib/utils";
import { formatElapsedTime } from "@/components/workflow/ai-generation-time";

export function AiGenerationMetrics({
  elapsedSeconds,
  tokenUsage,
  calculatingTokens = false,
  showTokens = true,
  className,
}: {
  elapsedSeconds: number;
  tokenUsage?: TokenUsage;
  calculatingTokens?: boolean;
  showTokens?: boolean;
  className?: string;
}) {
  const tokenTotal = resolveTokenTotal(tokenUsage);
  const tokenValue = calculatingTokens
    ? "calculating\u2026"
    : tokenTotal === undefined
      ? "unavailable"
      : tokenTotal.toLocaleString();

  return (
    <div className={cn("inline-flex shrink-0 items-center gap-1.5 text-xs tabular-nums text-muted-foreground", className)}>
      <span>Elapsed: {formatElapsedTime(elapsedSeconds)}</span>
      {showTokens ? (
        <>
          <span aria-hidden="true">{"\u00b7"}</span>
          <span>Tokens: {tokenValue}</span>
        </>
      ) : null}
    </div>
  );
}

export function AiGenerationCompletedMetrics({
  elapsedSeconds,
  tokenUsage,
}: {
  elapsedSeconds: number;
  tokenUsage?: TokenUsage;
}) {
  return (
    <div className="flex justify-end">
      <AiGenerationMetrics elapsedSeconds={elapsedSeconds} tokenUsage={tokenUsage} />
    </div>
  );
}

function resolveTokenTotal(tokenUsage?: TokenUsage) {
  if (typeof tokenUsage?.total === "number" && Number.isFinite(tokenUsage.total)) {
    return tokenUsage.total;
  }
  if (
    typeof tokenUsage?.input === "number"
    && Number.isFinite(tokenUsage.input)
    && typeof tokenUsage.output === "number"
    && Number.isFinite(tokenUsage.output)
  ) {
    return tokenUsage.input + tokenUsage.output;
  }
  return undefined;
}
