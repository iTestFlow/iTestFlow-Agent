import type { TokenUsage } from "@/modules/llm/llm-types";
import { TriangleAlert } from "lucide-react";
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
  warnings,
}: {
  elapsedSeconds: number;
  tokenUsage?: TokenUsage;
  warnings?: string[];
}) {
  const messages = warnings?.filter((entry) => entry.trim().length > 0) ?? [];
  return (
    <div className="flex flex-col items-end gap-1.5">
      <AiGenerationMetrics elapsedSeconds={elapsedSeconds} tokenUsage={tokenUsage} />
      {messages.length ? (
        <div
          role="status"
          className="flex max-w-prose items-start gap-1.5 rounded-md border border-warning/30 bg-warning/10 px-2.5 py-1.5 text-xs leading-5 text-warning-foreground dark:text-warning"
        >
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span>{messages.join(" ")}</span>
        </div>
      ) : null}
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
