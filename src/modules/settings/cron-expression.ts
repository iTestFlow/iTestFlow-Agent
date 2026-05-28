export const DEFAULT_AUTO_UPDATE_CRON_EXPRESSION = "0 2 * * *";

type CronFieldDefinition = {
  name: string;
  min: number;
  max: number;
};

const CRON_FIELDS: CronFieldDefinition[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day of week", min: 0, max: 7 },
];

export function validateCronExpression(expression: string): string | null {
  const parts = expression.trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 5) return "Enter a 5-field cron expression, for example 0 2 * * *.";

  for (let index = 0; index < CRON_FIELDS.length; index += 1) {
    const error = validateCronField(parts[index], CRON_FIELDS[index]);
    if (error) return error;
  }

  return null;
}

export function isValidCronExpression(expression: string) {
  return validateCronExpression(expression) === null;
}

export function isCronExpressionDue(expression: string, date = new Date()) {
  const parts = expression.trim().split(/\s+/);
  const parsed = parseCronExpression(expression);
  const dayOfWeek = date.getDay();
  const dayOfMonthMatches = parsed[2].has(date.getDate());
  const dayOfWeekMatches = parsed[4].has(dayOfWeek) || (dayOfWeek === 0 && parsed[4].has(7));
  const dayMatches = parts[2] === "*" || parts[4] === "*"
    ? dayOfMonthMatches && dayOfWeekMatches
    : dayOfMonthMatches || dayOfWeekMatches;

  return (
    parsed[0].has(date.getMinutes()) &&
    parsed[1].has(date.getHours()) &&
    parsed[3].has(date.getMonth() + 1) &&
    dayMatches
  );
}

export function minuteKeyForDate(date = new Date()) {
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hour = pad(date.getHours());
  const minute = pad(date.getMinutes());
  return `${year}-${month}-${day}T${hour}:${minute}`;
}

function parseCronExpression(expression: string) {
  const error = validateCronExpression(expression);
  if (error) throw new Error(error);
  return expression
    .trim()
    .split(/\s+/)
    .map((field, index) => parseCronField(field, CRON_FIELDS[index]));
}

function validateCronField(field: string, definition: CronFieldDefinition) {
  try {
    parseCronField(field, definition);
    return null;
  } catch (error) {
    return error instanceof Error
      ? error.message
      : `Invalid ${definition.name} field.`;
  }
}

function parseCronField(field: string, definition: CronFieldDefinition) {
  const values = new Set<number>();
  const segments = field.split(",");

  if (!field.trim() || segments.some((segment) => !segment.trim())) {
    throw new Error(`Invalid ${definition.name} field.`);
  }

  for (const segment of segments) {
    addCronSegmentValues(values, segment.trim(), definition);
  }

  if (!values.size) throw new Error(`Invalid ${definition.name} field.`);
  return values;
}

function addCronSegmentValues(values: Set<number>, segment: string, definition: CronFieldDefinition) {
  const [rangePart, stepPart] = segment.split("/");
  if (segment.split("/").length > 2) throw new Error(`Invalid ${definition.name} field.`);

  const step = stepPart === undefined ? 1 : parseCronNumber(stepPart, definition, "step");
  if (step < 1) throw new Error(`The ${definition.name} step must be greater than 0.`);

  const range = parseCronRange(rangePart, definition);
  for (let value = range.start; value <= range.end; value += step) {
    values.add(value);
  }
}

function parseCronRange(value: string, definition: CronFieldDefinition) {
  if (value === "*") return { start: definition.min, end: definition.max };

  if (value.includes("-")) {
    const [startValue, endValue] = value.split("-");
    if (!startValue || !endValue || value.split("-").length !== 2) {
      throw new Error(`Invalid ${definition.name} range.`);
    }
    const start = parseCronNumber(startValue, definition);
    const end = parseCronNumber(endValue, definition);
    if (start > end) throw new Error(`The ${definition.name} range start must be before the end.`);
    return { start, end };
  }

  const exact = parseCronNumber(value, definition);
  return { start: exact, end: exact };
}

function parseCronNumber(value: string, definition: CronFieldDefinition, label = definition.name) {
  if (!/^\d+$/.test(value)) throw new Error(`Invalid ${label} value in the ${definition.name} field.`);
  const parsed = Number(value);
  if (parsed < definition.min || parsed > definition.max) {
    throw new Error(`The ${definition.name} field must be between ${definition.min} and ${definition.max}.`);
  }
  return parsed;
}

function pad(value: number) {
  return value.toString().padStart(2, "0");
}
