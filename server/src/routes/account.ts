import { Router } from 'express';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../config.js';
import { db } from '../db/index.js';
import {
  budgets,
  devices,
  documents,
  expenses,
  memories,
  messages,
  notifications,
  pendingActions,
  reminders,
  serviceReports,
  users,
} from '../db/schema.js';
import { me, requireAuth } from '../middleware/auth.js';
import { verifyPassword } from '../lib/auth.js';
import { unauthorized } from '../lib/errors.js';
import { publicUser } from '../lib/auth.js';

const router = Router();
router.use(requireAuth);

router.get('/export', async (req, res) => {
  const user = me(req);
  const [reminderRows, expenseRows, budgetRows, memoryRows, documentRows, messageRows, notificationRows, reportRows] =
    await Promise.all([
      db.select().from(reminders).where(eq(reminders.userId, user.id)),
      db.select().from(expenses).where(eq(expenses.userId, user.id)),
      db.select().from(budgets).where(eq(budgets.userId, user.id)),
      db.select().from(memories).where(eq(memories.userId, user.id)),
      db.select().from(documents).where(eq(documents.userId, user.id)),
      db.select().from(messages).where(eq(messages.userId, user.id)),
      db.select().from(notifications).where(eq(notifications.userId, user.id)),
      db.select().from(serviceReports).where(eq(serviceReports.userId, user.id)),
    ]);

  res.setHeader('Content-Disposition', 'attachment; filename="my-life-ai-export.json"');
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    exportedAt: new Date().toISOString(),
    account: publicUser(user),
    reminders: reminderRows,
    expenses: expenseRows,
    budgets: budgetRows,
    memories: memoryRows,
    documents: documentRows.map(({ storagePath, ...rest }) => rest),
    messages: messageRows,
    notifications: notificationRows,
    serviceReports: reportRows,
  });
});

router.delete('/', async (req, res) => {
  const user = me(req);
  const { password } = z.object({ password: z.string().min(1).max(72) }).parse(req.body);
  if (!(await verifyPassword(password, user.passwordHash))) {
    throw unauthorized('Password is incorrect');
  }
  await db.delete(pendingActions).where(eq(pendingActions.userId, user.id));
  await db.delete(devices).where(eq(devices.userId, user.id));
  await rm(join(config.UPLOAD_DIR, user.id), { recursive: true, force: true });
  await db.delete(users).where(eq(users.id, user.id));
  res.status(204).end();
});

export default router;
