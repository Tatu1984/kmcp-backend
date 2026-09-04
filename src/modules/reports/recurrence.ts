import { ReportFrequency } from "@prisma/client";

import { AppException } from "@/common/errors/app.exception";

/**
 * When a scheduled report is next due, and what period it should cover.
 *
 * ## Why this file exists at all
 *
 * Everything in this database is stored in UTC and everything on every screen
 * is rendered in Asia/Kolkata. That is a fine arrangement right up to the
 * moment something has to *happen* at a local time. "The Monday morning
 * collection summary, at eight" is an instruction about a wall clock in
 * Kolkata, and a server that reasons in UTC will honour it at 08:00 UTC —
 * 13:30 in the afternoon, in the middle of the day it was meant to open.
 *
 * So a schedule stores its intent in pieces (frequency, hour, minute, weekday
 * or day of month, and the zone those are spoken in) and this module converts
 * that intent into the UTC instant the runner compares against `now`. The
 * instant is a derived value, recomputed after every run; the intent is what is
 * actually kept.
 *
 * ## Why there is no date library here
 *
 * `Intl.DateTimeFormat` already carries the IANA database that Node ships with,
 * and the only two operations needed are "what is the local wall clock at this
 * instant" and its inverse. Both are below, in twenty lines, and neither can
 * drift out of step with a dependency's idea of when Indian Standard Time
 * changed. IST has no daylight saving, but `timezone` is a column rather than a
 * constant — an authority elsewhere is allowed to set it — so the inverse below
 * does the offset correction properly rather than assuming a fixed +05:30.
 */

/** The recurrence intent, as `ReportSchedule` stores it. */
export interface RecurrenceRule {
  frequency: ReportFrequency;
  /** Local hour in `timezone`, 0–23. */
  hour: number;
  /** Local minute, 0–59. */
  minute: number;
  /** ISO weekday, 1 = Monday … 7 = Sunday. Required for WEEKLY. */
  weekday: number | null;
  /** 1–31, clamped to the last day of a short month. Required for MONTHLY. */
  dayOfMonth: number | null;
  /** An IANA zone name, e.g. `Asia/Kolkata`. */
  timezone: string;
}

/** A wall-clock reading in some zone. Months and days are 1-based, as people write them. */
export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** ISO weekday, 1 = Monday … 7 = Sunday. */
  weekday: number;
}

const ISO_WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export const WEEKDAY_NAMES = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

/**
 * Formatters are not cheap to construct and a sweep builds one per schedule, so
 * they are kept. The cache is keyed by zone name and is at most as large as the
 * number of distinct zones the authority has configured — in practice, one.
 */
const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  const cached = FORMATTERS.get(timeZone);
  if (cached) return cached;

  const built = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    // `hourCycle: h23` rather than `hour12: false`, which in some runtimes
    // renders midnight as "24" and would put every daily schedule a day out.
    hourCycle: "h23",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  FORMATTERS.set(timeZone, built);
  return built;
}

/** Whether the runtime recognises this as a zone. An unknown name would otherwise
 *  silently fall back to the host's own zone, which is UTC on every deployment. */
export function isKnownTimezone(name: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/** The wall clock in `timeZone` at this instant. */
export function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const parts = formatter(timeZone).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";

  return {
    year: Number(value("year")),
    month: Number(value("month")),
    day: Number(value("day")),
    hour: Number(value("hour")) % 24,
    minute: Number(value("minute")),
    second: Number(value("second")),
    weekday: ISO_WEEKDAYS.indexOf(value("weekday")) + 1,
  };
}

/** How far ahead of UTC the zone is at this instant, in milliseconds. */
function offsetAt(instant: Date, timeZone: string): number {
  const local = zonedParts(instant, timeZone);
  const asIfUtc = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
    local.second,
  );
  return asIfUtc - instant.getTime();
}

/**
 * The UTC instant at which the clock in `timeZone` reads this local time.
 *
 * The inverse of `zonedParts`, and the awkward direction: the offset that has
 * to be subtracted is itself a function of the instant being solved for. Two
 * passes settle it — guess with the offset in force at the naive instant, then
 * re-read the offset at that guess and correct. A single pass is wrong for any
 * local time within an offset's width of a daylight-saving boundary, which is
 * exactly the ninety minutes a 02:00 schedule would sit in.
 *
 * `Date.UTC` normalises out-of-range fields, so callers may pass day 0, day 32
 * or month 13 and get the sensible neighbouring date.
 */
export function instantOf(
  local: { year: number; month: number; day: number; hour: number; minute: number },
  timeZone: string,
): Date {
  const naive = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, 0, 0);
  const firstPass = naive - offsetAt(new Date(naive), timeZone);
  return new Date(naive - offsetAt(new Date(firstPass), timeZone));
}

/** The last day of a 1-based month — 28, 29, 30 or 31. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * The first firing strictly after `after`.
 *
 * Strictly after, and computed from `after` rather than from the schedule's
 * previous `nextRunAt`, which is the difference between a runner and a backlog.
 * A schedule that was paused for three weeks, or a deployment that was down for
 * a day, has missed occurrences; catching every one of them up would send an
 * officer twenty identical daily-collection reports the moment the platform
 * came back. The next one is due at the next real occurrence, and the missed
 * ones stay missed.
 */
export function nextRunAfter(rule: RecurrenceRule, after: Date): Date {
  const zone = rule.timezone;
  const local = zonedParts(after, zone);
  const at = (year: number, month: number, day: number): Date =>
    instantOf({ year, month, day, hour: rule.hour, minute: rule.minute }, zone);

  switch (rule.frequency) {
    case ReportFrequency.DAILY: {
      const today = at(local.year, local.month, local.day);
      // Tomorrow is expressed as "day + 1" and normalised by Date.UTC, so a
      // month or year boundary needs no special case.
      return today.getTime() > after.getTime()
        ? today
        : at(local.year, local.month, local.day + 1);
    }

    case ReportFrequency.WEEKLY: {
      const target = rule.weekday ?? 1;
      const ahead = (target - local.weekday + 7) % 7;
      const candidate = at(local.year, local.month, local.day + ahead);
      return candidate.getTime() > after.getTime()
        ? candidate
        : at(local.year, local.month, local.day + ahead + 7);
    }

    case ReportFrequency.MONTHLY: {
      const wanted = rule.dayOfMonth ?? 1;
      let year = local.year;
      let month = local.month;
      // Two passes: this month, then the next. A day-of-month of 31 in a short
      // month is clamped to the last day rather than spilling into the next one
      // — "the month-end statement on the 31st" must not arrive on 1 March.
      for (let step = 0; step < 2; step += 1) {
        const candidate = at(year, month, Math.min(wanted, daysInMonth(year, month)));
        if (candidate.getTime() > after.getTime()) return candidate;
        month += 1;
        if (month > 12) {
          month = 1;
          year += 1;
        }
      }
      // Unreachable: the second pass is always a whole month ahead of `after`.
      return at(year, month, Math.min(wanted, daysInMonth(year, month)));
    }
  }
}

/**
 * The period a run fired at `runAt` should report on.
 *
 * Always a whole number of *closed* local days ending yesterday, never a window
 * that runs up to the moment of the run. A collection summary that included
 * this morning would report a different total depending on what time the sweep
 * happened to reach it, and two officers comparing their copies would find they
 * disagreed. Yesterday is over; yesterday's number does not move.
 *
 * The boundaries are local midnights in the schedule's own zone, converted to
 * instants — so a daily report covers 00:00–23:59:59.999 Kolkata time and not
 * the five and a half hours either side of it that a UTC day would include.
 */
export function periodFor(rule: RecurrenceRule, runAt: Date): { from: Date; to: Date } {
  const zone = rule.timezone;
  const local = zonedParts(runAt, zone);
  const midnight = (day: number): Date =>
    instantOf({ year: local.year, month: local.month, day, hour: 0, minute: 0 }, zone);

  // The instant one millisecond before the local midnight that ends the window
  // — computed as a boundary rather than as 23:59:59.999, so nothing is lost on
  // a day that a daylight-saving change made 23 or 25 hours long.
  const endOfYesterday = new Date(midnight(local.day).getTime() - 1);

  switch (rule.frequency) {
    case ReportFrequency.DAILY:
      return { from: midnight(local.day - 1), to: endOfYesterday };

    case ReportFrequency.WEEKLY:
      // The seven closed days behind the run, not the ISO week: a Monday
      // schedule reports Monday to Sunday, and a Thursday one reports Thursday
      // to Wednesday, which is what the officer who chose the day meant.
      return { from: midnight(local.day - 7), to: endOfYesterday };

    case ReportFrequency.MONTHLY: {
      // The previous calendar month, whole. A month-end statement that covered
      // "the last thirty days" would double-count the overlap and miss a day in
      // February, and would not reconcile with anything the finance office holds.
      const firstOfThisMonth = instantOf(
        { year: local.year, month: local.month, day: 1, hour: 0, minute: 0 },
        zone,
      );
      const previousMonth = local.month === 1 ? 12 : local.month - 1;
      const previousYear = local.month === 1 ? local.year - 1 : local.year;
      return {
        from: instantOf(
          { year: previousYear, month: previousMonth, day: 1, hour: 0, minute: 0 },
          zone,
        ),
        to: new Date(firstOfThisMonth.getTime() - 1),
      };
    }
  }
}

/**
 * The recurrence in words — "Every Monday at 08:00 (Asia/Kolkata)".
 *
 * Built here rather than in the portal so the API and the screen cannot
 * describe the same row differently, and so a delivery can name its own cadence
 * without the portal being involved at all.
 */
export function describeRecurrence(rule: RecurrenceRule): string {
  const clock = `${String(rule.hour).padStart(2, "0")}:${String(rule.minute).padStart(2, "0")}`;
  const zone = rule.timezone;

  switch (rule.frequency) {
    case ReportFrequency.DAILY:
      return `Every day at ${clock} (${zone})`;
    case ReportFrequency.WEEKLY:
      return `Every ${WEEKDAY_NAMES[(rule.weekday ?? 1) - 1]} at ${clock} (${zone})`;
    case ReportFrequency.MONTHLY:
      return `On day ${rule.dayOfMonth ?? 1} of every month at ${clock} (${zone})`;
  }
}

/**
 * Refuses a rule that cannot fire, or that would fire somewhere nobody meant.
 *
 * Called on create *and* on update with the merged row rather than on the
 * request body, because a patch that changes only `frequency` can turn a valid
 * weekly rule into a monthly one with no day of month — and the shape that
 * matters is the one that ends up in the table.
 */
export function assertValidRecurrence(rule: RecurrenceRule): void {
  const issues: { field: string; issue: string }[] = [];

  if (!isKnownTimezone(rule.timezone)) {
    // An unrecognised name does not throw in `Intl`; it falls back to the host
    // zone, which on every deployment of this API is UTC. A schedule would then
    // silently run five and a half hours early for the rest of its life.
    issues.push({ field: "timezone", issue: `"${rule.timezone}" is not a known time zone` });
  }
  if (rule.frequency === ReportFrequency.WEEKLY && !rule.weekday) {
    issues.push({ field: "weekday", issue: "a weekly schedule needs a day of the week" });
  }
  if (rule.frequency === ReportFrequency.MONTHLY && !rule.dayOfMonth) {
    issues.push({ field: "dayOfMonth", issue: "a monthly schedule needs a day of the month" });
  }

  if (issues.length > 0) throw new AppException("VALIDATION_FAILED", issues);
}
