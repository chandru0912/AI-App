import { DateTime, IANAZone } from 'luxon';
import rrulePkg from 'rrule';

const { RRule } = rrulePkg;

export const isValidTimezone = (timezone: string) => IANAZone.isValidZone(timezone);

export type Recurrence = 'once' | 'daily' | 'weekly' | 'monthly' | 'yearly';

export function buildRrule(
  recurrence: Recurrence,
  dueAt: Date,
  timezone: string,
): string | null {
  if (recurrence === 'once') return null;
  const local = DateTime.fromJSDate(dueAt, { zone: timezone });
  switch (recurrence) {
    case 'daily':
      return 'FREQ=DAILY';
    case 'weekly': {
      const days = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
      return `FREQ=WEEKLY;BYDAY=${days[local.weekday - 1]}`;
    }
    case 'monthly':
      return `FREQ=MONTHLY;BYMONTHDAY=${local.day}`;
    case 'yearly':
      return `FREQ=YEARLY;BYMONTH=${local.month};BYMONTHDAY=${local.day}`;
  }
}

export function nextOccurrence(
  rrule: string | null,
  startAt: Date,
  timezone: string,
  after: Date,
): Date | null {
  if (!rrule) return null;
  try {
    const rule = new RRule({
      ...RRule.parseString(rrule),
      dtstart: startAt,
      tzid: timezone,
    });
    return rule.after(after, false) ?? null;
  } catch {
    return null;
  }
}

/** Next `count` occurrences, starting with the reminder's next run. */
export function upcomingOccurrences(
  rrule: string | null,
  nextRunAt: Date,
  startAt: Date,
  timezone: string,
  count = 20,
): Date[] {
  const out = [nextRunAt];
  let cursor = nextRunAt;
  while (out.length < count) {
    const next = nextOccurrence(rrule, startAt, timezone, cursor);
    if (!next) break;
    out.push(next);
    cursor = next;
  }
  return out;
}

export function formatDateTime(instant: Date | string, timezone: string, locale: string) {
  const tag = locale === 'ta' ? 'ta-IN' : 'en-IN';
  return new Intl.DateTimeFormat(tag, {
    timeZone: timezone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(instant));
}

export function formatTime(instant: Date | string, timezone: string, locale: string) {
  const tag = locale === 'ta' ? 'ta-IN' : 'en-IN';
  return new Intl.DateTimeFormat(tag, {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(instant));
}

export function monthKey(instant: Date, timezone: string) {
  return DateTime.fromJSDate(instant, { zone: timezone }).toFormat('yyyy-MM');
}

export type Period = 'day' | 'week' | 'month';

export function periodRange(period: Period, timezone: string, reference = new Date()) {
  const base = DateTime.fromJSDate(reference, { zone: timezone });
  const start =
    period === 'day'
      ? base.startOf('day')
      : period === 'week'
        ? base.startOf('week')
        : base.startOf('month');
  return {
    from: start.toUTC().toJSDate(),
    to:
      period === 'day'
        ? start.plus({ day: 1 }).toUTC().toJSDate()
        : period === 'week'
          ? start.plus({ week: 1 }).toUTC().toJSDate()
          : start.plus({ month: 1 }).toUTC().toJSDate(),
    label: start.toFormat(period === 'month' ? 'LLLL yyyy' : 'd LLL yyyy'),
    month: start.toFormat('yyyy-MM'),
  };
}

export function parseLocalDateTime(
  parts: { year: number; month: number; day: number; hour: number; minute: number },
  timezone: string,
): Date | null {
  const dt = DateTime.fromObject(parts, { zone: timezone });
  return dt.isValid ? dt.toUTC().toJSDate() : null;
}
