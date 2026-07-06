import { describe, expect, it, vi } from "vitest";

import {
  buildDailyCron,
  buildMonthlyCron,
  buildWeeklyCron,
  describeCron,
  findNextCronRun,
  formatTimeOfDay,
  parseSchedule,
  parseTimeInputValue,
  toTimeInputValue,
} from "./cron-schedule";

describe("parseSchedule", () => {
  it("recognises literal daily, weekly, and monthly shapes", () => {
    expect(parseSchedule("30 2 * * *")).toEqual({ mode: "daily", hour: 2, minute: 30 });
    expect(parseSchedule("0 14 * * 1")).toEqual({ mode: "weekly", hour: 14, minute: 0, dayOfWeek: 1 });
    expect(parseSchedule("15 6 5 * *")).toEqual({ mode: "monthly", hour: 6, minute: 15, dayOfMonth: 5 });
  });

  it("tolerates surrounding and repeated whitespace", () => {
    expect(parseSchedule("  0   2  * * *  ")).toEqual({ mode: "daily", hour: 2, minute: 0 });
  });

  it("normalises the Sunday alias 7 to 0", () => {
    expect(parseSchedule("0 2 * * 7")).toEqual({ mode: "weekly", hour: 2, minute: 0, dayOfWeek: 0 });
  });

  // Anything beyond single literal fields is treated as a custom expression.
  it.each([
    ["*/15 2 * * *", "minute step"],
    ["0 8-17 * * *", "hour range"],
    ["0,30 2 * * *", "minute list"],
    ["0 2 * 6 *", "restricted month"],
    ["0 2 * * 1-5", "day-of-week range"],
    ["0 2 15 * 1", "both day fields restricted"],
    ["60 2 * * *", "minute out of range"],
    ["0 24 * * *", "hour out of range"],
    ["0 2 0 * *", "day of month below 1"],
    ["0 2 32 * *", "day of month above 31"],
    ["0 2 * * 8", "day of week above 7"],
    ["0 2 * *", "4 fields"],
    ["0 2 * * * *", "6 fields"],
    ["", "empty"],
  ])("returns null for %s (%s)", (expression) => {
    expect(parseSchedule(expression)).toBeNull();
  });
});

describe("build*Cron", () => {
  it("clamps NaN to each field minimum", () => {
    expect(buildDailyCron(Number.NaN, Number.NaN)).toBe("0 0 * * *");
    expect(buildWeeklyCron(Number.NaN, Number.NaN, Number.NaN)).toBe("0 0 * * 0");
    expect(buildMonthlyCron(Number.NaN, Number.NaN, Number.NaN)).toBe("0 0 1 * *");
  });

  it("clamps out-of-range values into each field's bounds", () => {
    expect(buildDailyCron(30, 99)).toBe("59 23 * * *");
    expect(buildDailyCron(-4, -1)).toBe("0 0 * * *");
    expect(buildWeeklyCron(9, 2, 30)).toBe("30 2 * * 6");
    expect(buildWeeklyCron(-1, 2, 30)).toBe("30 2 * * 0");
  });

  it("caps the monthly day at 28 so the schedule fires every month", () => {
    expect(buildMonthlyCron(31, 4, 0)).toBe("0 4 28 * *");
    expect(buildMonthlyCron(0, 4, 0)).toBe("0 4 1 * *");
  });

  it("round-trips built expressions through parseSchedule", () => {
    expect(parseSchedule(buildDailyCron(2, 0))).toEqual({ mode: "daily", hour: 2, minute: 0 });
    expect(parseSchedule(buildWeeklyCron(5, 18, 45))).toEqual({ mode: "weekly", hour: 18, minute: 45, dayOfWeek: 5 });
    expect(parseSchedule(buildMonthlyCron(28, 23, 59))).toEqual({ mode: "monthly", hour: 23, minute: 59, dayOfMonth: 28 });
  });
});

describe("findNextCronRun", () => {
  it("returns the next match strictly after from, never from itself", () => {
    const from = new Date(2026, 5, 15, 10, 30, 0, 0); // exactly on the schedule
    expect(findNextCronRun("30 10 * * *", from)).toEqual(new Date(2026, 5, 16, 10, 30));
  });

  it("skips the current minute even when from has elapsed seconds", () => {
    const from = new Date(2026, 5, 15, 10, 30, 45, 500);
    expect(findNextCronRun("30 10 * * *", from)).toEqual(new Date(2026, 5, 16, 10, 30));
  });

  it("returns the upcoming minute with seconds zeroed when it is still ahead", () => {
    const from = new Date(2026, 5, 15, 10, 29, 45, 500);
    expect(findNextCronRun("30 10 * * *", from)).toEqual(new Date(2026, 5, 15, 10, 30, 0, 0));
  });

  it("advances across a day boundary", () => {
    expect(findNextCronRun("5 0 * * *", new Date(2026, 5, 15, 23, 59))).toEqual(
      new Date(2026, 5, 16, 0, 5),
    );
  });

  it("advances across month and year boundaries", () => {
    // September has no 31st, so a day-31 schedule skips to October.
    expect(findNextCronRun("0 2 31 * *", new Date(2026, 8, 1, 0, 0))).toEqual(
      new Date(2026, 9, 31, 2, 0),
    );
    expect(findNextCronRun("0 2 * * *", new Date(2026, 11, 31, 23, 0))).toEqual(
      new Date(2027, 0, 1, 2, 0),
    );
  });

  it("honours weekly day-of-week schedules including the Sunday alias", () => {
    // 2026-06-15 is a Monday; the next Sunday (alias 7) run is June 21.
    expect(findNextCronRun("0 9 * * 7", new Date(2026, 5, 15, 12, 0))).toEqual(
      new Date(2026, 5, 21, 9, 0),
    );
  });

  it("defaults from to the current time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 15, 10, 29, 30));
    expect(findNextCronRun("30 10 * * *")).toEqual(new Date(2026, 5, 15, 10, 30));
  });

  it("does not mutate the from date", () => {
    const from = new Date(2026, 5, 15, 10, 30, 45, 500);
    findNextCronRun("30 10 * * *", from);
    expect(from).toEqual(new Date(2026, 5, 15, 10, 30, 45, 500));
  });

  it("returns null for invalid expressions", () => {
    expect(findNextCronRun("not a cron", new Date(2026, 5, 15))).toBeNull();
    expect(findNextCronRun("60 * * * *", new Date(2026, 5, 15))).toBeNull();
  });

  // Exhausts the full ~13-month minute scan, so allow extra time on slow machines.
  it("returns null when the expression never matches within the scan window", { timeout: 20_000 }, () => {
    // February 30th never exists, so the scan finds no match.
    expect(findNextCronRun("0 0 30 2 *", new Date(2026, 5, 15))).toBeNull();
  });
});

describe("describeCron", () => {
  it("summarises the three literal schedule shapes", () => {
    expect(describeCron("0 2 * * *")).toBe("Runs daily at 2:00 AM local server time.");
    expect(describeCron("30 14 * * 1")).toBe("Runs every Monday at 2:30 PM local server time.");
    expect(describeCron("5 0 28 * *")).toBe("Runs on day 28 of every month at 12:05 AM local server time.");
  });

  it("labels invalid and non-literal expressions", () => {
    expect(describeCron("not a cron")).toBe("Invalid schedule");
    // Valid cron, but not a shape parseSchedule recognises (stepped minute).
    expect(describeCron(" */5 2 * * * ")).toBe("Runs on a custom schedule (*/5 2 * * *).");
  });
});

describe("time-of-day formatting", () => {
  it("formats 12-hour clock boundaries", () => {
    expect(formatTimeOfDay(0, 0)).toBe("12:00 AM");
    expect(formatTimeOfDay(12, 5)).toBe("12:05 PM");
    expect(formatTimeOfDay(23, 59)).toBe("11:59 PM");
  });

  it("round-trips through the <input type=\"time\"> value format", () => {
    expect(toTimeInputValue({ hour: 2, minute: 5 })).toBe("02:05");
    expect(parseTimeInputValue("02:05")).toEqual({ hour: 2, minute: 5 });
    expect(parseTimeInputValue(" 23:59 ")).toEqual({ hour: 23, minute: 59 });
  });

  it("rejects malformed or out-of-range time input values", () => {
    expect(parseTimeInputValue("24:00")).toBeNull();
    expect(parseTimeInputValue("12:60")).toBeNull();
    expect(parseTimeInputValue("noon")).toBeNull();
    expect(parseTimeInputValue("7:5")).toBeNull();
  });
});
