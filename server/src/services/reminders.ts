import { randomUUID } from 'node:crypto';
import { and, asc, eq, gte, lte } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { reminderEvents, reminders } from '../db/schema.js';
import { badRequest, notFound } from '../lib/errors.js';
import { normalizeAdvance, reminderCreateBodySchema } from '../lib/schemas.js';
import {
  buildRrule,
  formatDateTime,
  isValidTimezone,
  nextOccurrence,
  upcomingOccurrences,
} from '../lib/time.js';
import type { UserRow } from '../lib/auth.js';

type ReminderRow = typeof reminders.$inferSelect;
type CreateBody = z.infer<typeof reminderCreateBodySchema>;

export interface ReminderDto {
  id: string;
  title: string;
  notes: string | null;
  category: string;
  amount: number | null;
  startAt: string;
  nextRunAt: string;
  rrule: string | null;
  timezone: string;
  advanceMinutes: number[];
  status: string;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  upcoming: string[];
}

export function reminderDto(row: ReminderRow, upcomingCount = 20): ReminderDto {
  return {
    id: row.id,
    title: row.title,
    notes: row.notes,
    category: row.category,
    amount: row.amount === null ? null : Number(row.amount),
    startAt: row.startAt.toISOString(),
    nextRunAt: row.nextRunAt.toISOString(),
    rrule: row.rrule,
    timezone: row.timezone,
    advanceMinutes: row.advanceMinutes ?? [],
    status: row.status,
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    upcoming: upcomingOccurrences(
      row.rrule,
      row.nextRunAt,
      row.startAt,
      row.timezone,
      upcomingCount,
    ).map((d) => d.toISOString()),
  };
}

function scheduleFor(
  input: Pick<CreateBody, 'startAt' | 'recurrence' | 'rrule' | 'timezone'>,
  timezone: string,
) {
  const startAt = new Date(input.startAt);
  const recurrence = input.recurrence;
  const rrule =
    input.rrule?.trim() || buildRrule(recurrence, startAt, timezone);
  if (rrule) {
    const sample = nextOccurrence(rrule, startAt, timezone, startAt);
    if (!sample) throw badRequest('Invalid or empty recurrence rule');
  }
  let nextRunAt = startAt;
  if (rrule && startAt <= new Date()) {
    const next = nextOccurrence(rrule, startAt, timezone, new Date());
    if (!next) throw badRequest('This schedule has no future occurrences');
    nextRunAt = next;
  }
  if (!rrule && startAt.getTime() < Date.now() - 60_000) {
    throw badRequest('Reminder time must be in the future');
  }
  return { startAt, rrule, nextRunAt };
}

export async function createReminder(user: UserRow, input: CreateBody): Promise<ReminderRow> {
  const timezone = input.timezone ?? user.timezone;
  if (!isValidTimezone(timezone)) throw badRequest('Invalid timezone');
  const schedule = scheduleFor({ ...input, timezone }, timezone);

  const id = randomUUID();
  const rows = await db
    .insert(reminders)
    .values({
      id,
      userId: user.id,
      title: input.title,
      notes: input.notes,
      category: input.category,
      amount: input.amount === undefined ? null : String(input.amount),
      startAt: schedule.startAt,
      nextRunAt: schedule.nextRunAt,
      rrule: schedule.rrule,
      timezone,
      advanceMinutes: normalizeAdvance(input.advanceMinutes),
      status: 'active',
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('Failed to create reminder');
  await db.insert(reminderEvents).values({
    id: randomUUID(),
    reminderId: id,
    userId: user.id,
    occurrenceAt: schedule.nextRunAt,
    action: 'created',
  });
  return row;
}

export async function getOwnedReminder(userId: string, id: string): Promise<ReminderRow> {
  const rows = await db
    .select()
    .from(reminders)
    .where(and(eq(reminders.id, id), eq(reminders.userId, userId)))
    .limit(1);
  const row = rows[0];
  if (!row) throw notFound('Reminder');
  return row;
}

export async function listReminders(
  userId: string,
  options: { status?: string; from?: Date; to?: Date; limit?: number } = {},
) {
  const status = options.status ?? 'active';
  const filters = [eq(reminders.userId, userId)];
  if (status !== 'all') filters.push(eq(reminders.status, status));
  if (options.from) filters.push(gte(reminders.nextRunAt, options.from));
  if (options.to) filters.push(lte(reminders.nextRunAt, options.to));

  return db
    .select()
    .from(reminders)
    .where(and(...filters))
    .orderBy(asc(reminders.nextRunAt))
    .limit(Math.min(options.limit ?? 100, 200));
}

export async function updateReminderMeta(
  user: UserRow,
  id: string,
  patch: { title?: string; category?: string; notes?: string | null; amount?: number | null },
) {
  const existing = await getOwnedReminder(user.id, id);
  const rows = await db
    .update(reminders)
    .set({
      title: patch.title ?? existing.title,
      category: patch.category ?? existing.category,
      notes: patch.notes === undefined ? existing.notes : patch.notes,
      amount:
        patch.amount === undefined
          ? existing.amount
          : patch.amount === null
            ? null
            : String(patch.amount),
      updatedAt: new Date(),
    })
    .where(and(eq(reminders.id, id), eq(reminders.userId, user.id)))
    .returning();
  const row = rows[0];
  if (!row) throw notFound('Reminder');
  return row;
}

export async function rescheduleReminder(
  user: UserRow,
  id: string,
  input: { startAt: string; recurrence?: CreateBody['recurrence']; rrule?: string; timezone?: string },
) {
  const existing = await getOwnedReminder(user.id, id);
  const timezone = input.timezone ?? existing.timezone;
  if (!isValidTimezone(timezone)) throw badRequest('Invalid timezone');
  const recurrence = input.recurrence ?? 'once';
  const rrule =
    input.rrule !== undefined
      ? input.rrule || null
      : input.recurrence
        ? buildRrule(recurrence, new Date(input.startAt), timezone)
        : existing.rrule;
  const schedule = scheduleFor(
    { startAt: input.startAt, recurrence, rrule: rrule ?? undefined, timezone },
    timezone,
  );
  const rows = await db
    .update(reminders)
    .set({
      startAt: schedule.startAt,
      nextRunAt: schedule.nextRunAt,
      rrule: schedule.rrule,
      timezone,
      status: 'active',
      completedAt: null,
      updatedAt: new Date(),
    })
    .where(and(eq(reminders.id, id), eq(reminders.userId, user.id)))
    .returning();
  const row = rows[0];
  if (!row) throw notFound('Reminder');
  await db.insert(reminderEvents).values({
    id: randomUUID(),
    reminderId: id,
    userId: user.id,
    occurrenceAt: schedule.nextRunAt,
    action: 'rescheduled',
  });
  return row;
}

export async function completeReminder(user: UserRow, id: string) {
  const existing = await getOwnedReminder(user.id, id);
  if (existing.status === 'completed') return existing;

  const now = new Date();
  let status = 'completed';
  let nextRunAt = existing.nextRunAt;
  if (existing.rrule) {
    const base = existing.nextRunAt > now ? existing.nextRunAt : now;
    const next = nextOccurrence(existing.rrule, existing.startAt, existing.timezone, base);
    if (next) {
      nextRunAt = next;
      status = 'active';
    }
  }

  const rows = await db
    .update(reminders)
    .set({
      status,
      nextRunAt,
      completedAt: status === 'completed' ? now : null,
      updatedAt: now,
    })
    .where(and(eq(reminders.id, id), eq(reminders.userId, user.id)))
    .returning();
  const row = rows[0];
  if (!row) throw notFound('Reminder');
  await db.insert(reminderEvents).values({
    id: randomUUID(),
    reminderId: id,
    userId: user.id,
    occurrenceAt: existing.nextRunAt,
    action: 'completed',
  });
  return row;
}

export async function snoozeReminder(user: UserRow, id: string, minutes: number) {
  const existing = await getOwnedReminder(user.id, id);
  if (existing.status === 'completed') throw badRequest('This reminder is already completed');
  const nextRunAt = new Date(Date.now() + minutes * 60_000);
  const rows = await db
    .update(reminders)
    .set({ nextRunAt, status: 'active', updatedAt: new Date() })
    .where(and(eq(reminders.id, id), eq(reminders.userId, user.id)))
    .returning();
  const row = rows[0];
  if (!row) throw notFound('Reminder');
  await db.insert(reminderEvents).values({
    id: randomUUID(),
    reminderId: id,
    userId: user.id,
    occurrenceAt: existing.nextRunAt,
    action: 'snoozed',
    note: `${minutes} minutes`,
  });
  return row;
}

export async function deleteReminder(userId: string, id: string) {
  await getOwnedReminder(userId, id);
  await db.delete(reminders).where(and(eq(reminders.id, id), eq(reminders.userId, userId)));
}

export async function reminderHistory(userId: string, id: string) {
  await getOwnedReminder(userId, id);
  return db
    .select()
    .from(reminderEvents)
    .where(eq(reminderEvents.reminderId, id))
    .orderBy(asc(reminderEvents.createdAt));
}

/** Offset 0 is the due time; advance offsets add earlier notifications. */
export function notificationTimes(reminder: ReminderRow, occurrenceAt: Date) {
  const offsets = [0, ...(reminder.advanceMinutes ?? [])];
  return [...new Set(offsets)].map((offsetMinutes) => ({
    offsetMinutes,
    notifyAt: new Date(occurrenceAt.getTime() - offsetMinutes * 60_000),
  }));
}

export function reminderDescription(row: ReminderRow, locale: string) {
  return `${row.title} — ${formatDateTime(row.nextRunAt, row.timezone, locale)}`;
}
