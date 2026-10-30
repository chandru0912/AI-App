import { Router } from 'express';
import { z } from 'zod';
import { me, requireAuth } from '../middleware/auth.js';
import {
  REMINDER_CATEGORIES,
  RECURRENCES,
  isoDateTime,
  reminderCreateBodySchema,
} from '../lib/schemas.js';
import { badRequest } from '../lib/errors.js';
import {
  completeReminder,
  createReminder,
  deleteReminder,
  getOwnedReminder,
  listReminders,
  reminderDto,
  reminderHistory,
  rescheduleReminder,
  snoozeReminder,
  updateReminderMeta,
} from '../services/reminders.js';

const router = Router();
router.use(requireAuth);

const patchSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  category: z.enum(REMINDER_CATEGORIES).optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
  amount: z.number().positive().max(10_000_000).nullable().optional(),
});

const rescheduleSchema = z.object({
  startAt: isoDateTime,
  recurrence: z.enum(RECURRENCES).optional(),
  rrule: z.string().max(500).optional(),
  timezone: z.string().max(80).optional(),
});

router.get('/', async (req, res) => {
  const status = z.enum(['active', 'completed', 'all']).catch('active').parse(req.query.status);
  const from = req.query.from ? new Date(String(req.query.from)) : undefined;
  const to = req.query.to ? new Date(String(req.query.to)) : undefined;
  if (from && Number.isNaN(from.getTime())) throw badRequest('Invalid from date');
  if (to && Number.isNaN(to.getTime())) throw badRequest('Invalid to date');
  const rows = await listReminders(me(req).id, { status, from, to });
  res.json({ reminders: rows.map((row) => reminderDto(row)) });
});

router.post('/', async (req, res) => {
  const input = reminderCreateBodySchema.parse(req.body);
  const row = await createReminder(me(req), input);
  res.status(201).json({ reminder: reminderDto(row) });
});

router.get('/:id', async (req, res) => {
  const row = await getOwnedReminder(me(req).id, req.params.id);
  res.json({ reminder: reminderDto(row) });
});

router.patch('/:id', async (req, res) => {
  const input = patchSchema.parse(req.body);
  const row = await updateReminderMeta(me(req), req.params.id, input);
  res.json({ reminder: reminderDto(row) });
});

router.post('/:id/complete', async (req, res) => {
  const row = await completeReminder(me(req), req.params.id);
  res.json({ reminder: reminderDto(row) });
});

router.post('/:id/snooze', async (req, res) => {
  const { minutes } = z.object({ minutes: z.number().int().min(1).max(10080) }).parse(req.body);
  const row = await snoozeReminder(me(req), req.params.id, minutes);
  res.json({ reminder: reminderDto(row) });
});

router.post('/:id/reschedule', async (req, res) => {
  const input = rescheduleSchema.parse(req.body);
  const row = await rescheduleReminder(me(req), req.params.id, input);
  res.json({ reminder: reminderDto(row) });
});

router.get('/:id/history', async (req, res) => {
  const rows = await reminderHistory(me(req).id, req.params.id);
  res.json({
    history: rows.map((row) => ({
      id: row.id,
      action: row.action,
      occurrenceAt: row.occurrenceAt.toISOString(),
      note: row.note,
      createdAt: row.createdAt.toISOString(),
    })),
  });
});

router.delete('/:id', async (req, res) => {
  await deleteReminder(me(req).id, req.params.id);
  res.status(204).end();
});

export default router;
