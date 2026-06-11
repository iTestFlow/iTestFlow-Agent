import {
  isCronExpressionDue,
  isValidCronExpression,
} from "@/modules/settings/cron-expression";

/**
 * Pure, client-safe helpers for translating between the friendly "Daily at HH:MM"
 * scheduler UI and the raw 5-field cron expression the backend stores. The form
 * always persists a raw cron string; these helpers only shape how it is presented
 * and edited. Anything that is not a simple daily schedule round-trips losslessly
 * as a "custom" expression.
 */

export type DailySchedule = { hour: number; minute: number };

export type ScheduleMode = "daily" | "weekly" | "monthly";

export type ParsedSchedule =
  | { mode: "daily"; hour: number; minute: number }
  | { mode: "weekly"; hour: number; minute: number; dayOfWeek: number }
  | { mode: "monthly"; hour: number; minute: number; dayOfMonth: number };

export const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

const LITERAL_MINUTE = /^([0-9]|[1-5][0-9])$/;
const LITERAL_HOUR = /^([0-9]|1[0-9]|2[0-3])$/;
const LITERAL_DAY_OF_WEEK = /^[0-7]$/;
const LITERAL_DAY_OF_MONTH = /^([1-9]|[12][0-9]|3[01])$/;

/** Builds a daily cron expression from an hour/minute, clamping to valid ranges. */
export function buildDailyCron(hour: number, minute: number): string {
  return `${clamp(Math.round(minute), 0, 59)} ${clamp(Math.round(hour), 0, 23)} * * *`;
}

/** Builds a weekly cron expression (a single weekday, 0=Sunday … 6=Saturday). */
export function buildWeeklyCron(dayOfWeek: number, hour: number, minute: number): string {
  return `${clamp(Math.round(minute), 0, 59)} ${clamp(Math.round(hour), 0, 23)} * * ${clamp(Math.round(dayOfWeek), 0, 6)}`;
}

/** Builds a monthly cron expression (day of month capped at 28 so it runs every month). */
export function buildMonthlyCron(dayOfMonth: number, hour: number, minute: number): string {
  return `${clamp(Math.round(minute), 0, 59)} ${clamp(Math.round(hour), 0, 23)} ${clamp(Math.round(dayOfMonth), 1, 28)} * *`;
}

/**
 * Recognises the friendly schedule shapes the UI can edit (daily / weekly /
 * monthly) from a raw cron expression. Anything else (steps, ranges, lists,
 * multi-value fields) returns null and is treated as a custom expression.
 */
export function parseSchedule(expression: string): ParsedSchedule | null {
  const parts = expression.trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 5) return null;
  const [minuteField, hourField, dayOfMonth, month, dayOfWeek] = parts;
  if (!LITERAL_MINUTE.test(minuteField) || !LITERAL_HOUR.test(hourField) || month !== "*") return null;
  const minute = Number(minuteField);
  const hour = Number(hourField);

  if (dayOfMonth === "*" && dayOfWeek === "*") return { mode: "daily", hour, minute };
  if (dayOfMonth === "*" && LITERAL_DAY_OF_WEEK.test(dayOfWeek)) {
    return { mode: "weekly", hour, minute, dayOfWeek: Number(dayOfWeek) % 7 };
  }
  if (dayOfWeek === "*" && LITERAL_DAY_OF_MONTH.test(dayOfMonth)) {
    return { mode: "monthly", hour, minute, dayOfMonth: Number(dayOfMonth) };
  }
  return null;
}

/**
 * Computes the next datetime a cron expression is due, scanning minute-by-minute
 * up to ~13 months ahead. Mirrors the calculation used in the top bar. Returns
 * null if the expression is invalid or never matches within the window.
 */
export function findNextCronRun(expression: string, from: Date = new Date()): Date | null {
  if (!isValidCronExpression(expression)) return null;

  const candidate = new Date(from);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  const maxChecks = 60 * 24 * 366;
  for (let index = 0; index < maxChecks; index += 1) {
    if (isCronExpressionDue(expression, candidate)) return new Date(candidate);
    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  return null;
}

/** Human-readable summary of a cron expression for the scheduler UI. */
export function describeCron(expression: string): string {
  if (!isValidCronExpression(expression)) return "Invalid schedule";
  const schedule = parseSchedule(expression);
  if (schedule?.mode === "daily") {
    return `Runs daily at ${formatTimeOfDay(schedule.hour, schedule.minute)} local server time.`;
  }
  if (schedule?.mode === "weekly") {
    return `Runs every ${WEEKDAY_NAMES[schedule.dayOfWeek]} at ${formatTimeOfDay(schedule.hour, schedule.minute)} local server time.`;
  }
  if (schedule?.mode === "monthly") {
    return `Runs on day ${schedule.dayOfMonth} of every month at ${formatTimeOfDay(schedule.hour, schedule.minute)} local server time.`;
  }
  return `Runs on a custom schedule (${expression.trim()}).`;
}

/** Formats an hour/minute as a 12-hour clock time, e.g. "2:00 AM". */
export function formatTimeOfDay(hour: number, minute: number): string {
  const period = hour < 12 ? "AM" : "PM";
  const twelveHour = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelveHour}:${minute.toString().padStart(2, "0")} ${period}`;
}

/** Converts an {hour, minute} into the `HH:MM` value an `<input type="time">` expects. */
export function toTimeInputValue(schedule: DailySchedule): string {
  return `${schedule.hour.toString().padStart(2, "0")}:${schedule.minute.toString().padStart(2, "0")}`;
}

/** Parses an `<input type="time">` `HH:MM` value into {hour, minute}, or null. */
export function parseTimeInputValue(value: string): DailySchedule | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}
