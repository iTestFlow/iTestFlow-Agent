import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDateTime(value: string | Date) {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function scoreLabel(score: number) {
  if (score >= 85) return "Excellent / Ready";
  if (score >= 70) return "Good / Minor review";
  if (score >= 50) return "Needs refinement";
  return "Poor / Not ready";
}
