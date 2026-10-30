import { and, eq, inArray, lte } from 'drizzle-orm';
import { db } from '../db/index.js';
import { devices, notifications, reminders, users } from '../db/schema.js';
import { formatDateTime, nextOccurrence } from '../lib/time.js';
import { removeInvalidTokens, sendPush } from '../services/push.js';
import { notificationTimes } from '../services/reminders.js';

let timer: NodeJS.Timeout | null = null;
let running = false;

export async function runSchedulerOnce(now = new Date()) {
  const horizon = new Date(now.getTime() + 8 * 24 * 60 * 60_000);
  const rows = await db
    .select({ reminder: reminders, user: users })
    .from(reminders)
    .innerJoin(users, eq(users.id, reminders.userId))
    .where(and(eq(reminders.status, 'active'), lte(reminders.nextRunAt, horizon)))
    .limit(500);

  let created = 0;
  let pushed = 0;

  for (const { reminder, user } of rows) {
    try {
      const occurrence = reminder.nextRunAt;
      const occurrenceIso = occurrence.toISOString();
      const times = notificationTimes(reminder, occurrence);
      const locale = user.locale === 'ta' ? 'ta' : 'en';
      const dueLabel = formatDateTime(occurrence, reminder.timezone, locale);
      const advanceLabels: Record<number, string> = {
        0: locale === 'ta' ? `நேரம்: ${dueLabel}` : `Due: ${dueLabel}`,
        1440: locale === 'ta' ? `நாளை: ${dueLabel}` : `Tomorrow: ${dueLabel}`,
      };

      let dueWasNew = false;
      for (const time of times) {
        if (time.notifyAt > now) continue;
        const dedupeKey = `${reminder.id}:${occurrenceIso}:${time.offsetMinutes}`;
        const inserted = await db
          .insert(notifications)
          .values({
            id: crypto.randomUUID(),
            userId: user.id,
            reminderId: reminder.id,
            occurrenceAt: occurrence,
            offsetMinutes: time.offsetMinutes,
            kind: time.offsetMinutes === 0 ? 'reminder' : 'advance',
            dedupeKey,
            title: reminder.title,
            body:
              advanceLabels[time.offsetMinutes] ??
              (locale === 'ta'
                ? `${time.offsetMinutes} நிமிடங்களுக்கு முன் — ${dueLabel}`
                : `${time.offsetMinutes} minutes before — ${dueLabel}`),
            scheduledFor: time.notifyAt,
          })
          .onConflictDoNothing({ target: notifications.dedupeKey })
          .returning({ id: notifications.id });

        const notification = inserted[0];
        if (!notification) continue;
        created += 1;
        if (time.offsetMinutes === 0) dueWasNew = true;

        let ticketId: string | null = null;
        if (user.notificationsEnabled) {
          const tokens = await db
            .select({ token: devices.expoPushToken })
            .from(devices)
            .where(eq(devices.userId, user.id));
          if (tokens.length > 0) {
            try {
              const sent = await sendPush(
                tokens.map((t) => t.token),
                {
                  title: reminder.title,
                  body: advanceLabels[time.offsetMinutes] ?? dueLabel,
                  tag: `${reminder.id}:${occurrenceIso}`,
                  data: {
                    type: 'reminder',
                    reminderId: reminder.id,
                    occurrenceId: occurrenceIso,
                    notificationId: notification.id,
                  },
                },
              );
              ticketId = sent.tickets.find((t) => t.id)?.id ?? null;
              if (sent.invalidTokens.length > 0) await removeInvalidTokens(sent.invalidTokens);
              pushed += sent.tickets.filter((t) => t.id).length;
            } catch (error) {
              console.error(`Push failed for reminder ${reminder.id}:`, error);
            }
          }
        }

        await db
          .update(notifications)
          .set({ sentAt: new Date(), pushTicketId: ticketId })
          .where(eq(notifications.id, notification.id));
      }

      if (dueWasNew && reminder.rrule) {
        const base = occurrence > now ? occurrence : now;
        const next = nextOccurrence(reminder.rrule, reminder.startAt, reminder.timezone, base);
        await db
          .update(reminders)
          .set({
            nextRunAt: next ?? occurrence,
            status: next ? 'active' : 'completed',
            updatedAt: new Date(),
          })
          .where(eq(reminders.id, reminder.id));
      }
    } catch (error) {
      console.error(`Scheduler failed for reminder ${reminder.id}:`, error);
    }
  }

  return { scanned: rows.length, created, pushed };
}

export function startScheduler(intervalMs = 60_000) {
  if (timer) return;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await runSchedulerOnce();
      if (result.created > 0) {
        console.log(`Scheduler: ${result.created} notification(s), ${result.pushed} push(es)`);
      }
    } catch (error) {
      console.error('Scheduler tick failed:', error);
    } finally {
      running = false;
    }
  };
  void tick();
  timer = setInterval(() => void tick(), intervalMs);
  console.log(`Reminder scheduler running every ${intervalMs / 1000}s`);
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}
