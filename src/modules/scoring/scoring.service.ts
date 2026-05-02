export type ScoreResult = {
  value: number;
  label: "Excellent / Ready" | "Good / Minor review" | "Needs refinement" | "Poor / Not ready";
  explanation: string;
  factors: string[];
};

export function scoreFromFactors(input: {
  base?: number;
  positiveFactors?: string[];
  negativeFactors?: string[];
}): ScoreResult {
  const base = input.base ?? 75;
  const positive = input.positiveFactors?.length ?? 0;
  const negative = input.negativeFactors?.length ?? 0;
  const value = clamp(base + positive * 4 - negative * 7);

  return {
    value,
    label: labelForScore(value),
    explanation: `Score calculated from ${positive} positive factors and ${negative} negative factors.`,
    factors: [...(input.positiveFactors ?? []), ...(input.negativeFactors ?? [])],
  };
}

export function labelForScore(value: number): ScoreResult["label"] {
  if (value >= 85) return "Excellent / Ready";
  if (value >= 70) return "Good / Minor review";
  if (value >= 50) return "Needs refinement";
  return "Poor / Not ready";
}

function clamp(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}
