import { Router } from 'express';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { devices, notifications } from '../db/schema.js';
import { me, requireAuth } from '../middleware/auth.js';
import { notFound } from '../lib/errors.js';

const router = Router();
router.use(requireAuth);

const dto = (row: typeof notifications.$inferSelect) => ({
  id: row.id,
  kind: row.kind,
  title: row.title,
  body: row.body,
  reminderId: row.reminderId,
  scheduledFor: row.scheduledFor.toISOString(),
  sentAt: row.sentAt?.toISOString() ?? null,
  readAt: row.readAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
});

router.get('/', async (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
  const rows = await db
    .select()
    .from(notifications)
    .where(eq(notifications.userId, me(req).id))
    .orderBy(desc(notifications.createdAt))
    .limit(limit);
  res.json({
    notifications: rows.map(dto),
    unread: rows.filter((row) => row.readAt === null).length,
  });
});

router.post('/devices', async (req, res) => {
  const input = z
    .object({ token: z.string().min(10).max(200), platform: z.enum(['ios', 'android']).default('android') })
    .parse(req.body);
  const rows = await db
    .insert(devices)
    .values({
      id: crypto.randomUUID(),
      userId: me(req).id,
      expoPushToken: input.token,
      platform: input.platform,
    })
    .onConflictDoUpdate({
      target: devices.expoPushToken,
      set: { userId: me(req).id, platform: input.platform, lastSeenAt: new Date() },
    })
    .returning({ id: devices.id });
  res.status(201).json({ deviceId: rows[0]!.id });
});

router.delete('/devices', async (req, res) => {
  const { token } = z.object({ token: z.string().min(10).max(200) }).parse(req.body);
  await db
    .delete(devices)
    .where(and(eq(devices.userId, me(req).id), eq(devices.expoPushToken, token)));
  res.status(204).end();
});

router.post('/read-all', async (req, res) => {
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(eq(notifications.userId, me(req).id));
  res.status(204).end();
});

router.post('/:id/read', async (req, res) => {
  const rows = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.id, req.params.id), eq(notifications.userId, me(req).id)))
    .returning();
  if (rows.length === 0) throw notFound('Notification');
  res.json({ notification: dto(rows[0]!) });
});

router.delete('/:id', async (req, res) => {
  const rows = await db
    .delete(notifications)
    .where(and(eq(notifications.id, req.params.id), eq(notifications.userId, me(req).id)))
    .returning({ id: notifications.id });
  if (rows.length === 0) throw notFound('Notification');
  res.status(204).end();
});

export default router;
