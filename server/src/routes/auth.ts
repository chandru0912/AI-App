import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { me, requireAuth } from '../middleware/auth.js';
import {
  createSession,
  dummyHash,
  findSessionByToken,
  hashPassword,
  issueAccessToken,
  publicUser,
  revokeSession,
  verifyPassword,
} from '../lib/auth.js';
import { ApiError, badRequest, unauthorized } from '../lib/errors.js';
import { isValidTimezone } from '../lib/time.js';
import { rateLimit } from 'express-rate-limit';

const router = Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again later.' } },
});

const registerSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(8).max(72),
  name: z.string().trim().min(1).max(80),
  locale: z.enum(['en', 'ta']).default('en'),
  timezone: z.string().max(80).default('Asia/Kolkata'),
});

const loginSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(72),
});

const refreshSchema = z.object({ refreshToken: z.string().min(20).max(200) });

const updateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  locale: z.enum(['en', 'ta']).optional(),
  timezone: z.string().max(80).optional(),
  theme: z.enum(['dark', 'light', 'system']).optional(),
  notificationsEnabled: z.boolean().optional(),
});

async function tokensFor(userId: string) {
  const session = await createSession(userId);
  return {
    accessToken: await issueAccessToken(userId, session.id),
    refreshToken: session.token,
    refreshExpiresAt: session.expiresAt.toISOString(),
  };
}

router.post('/register', authLimiter, async (req, res) => {
  const input = registerSchema.parse(req.body);
  const email = input.email.toLowerCase();
  if (!isValidTimezone(input.timezone)) throw badRequest('Invalid timezone');

  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = ${email}`)
    .limit(1);
  if (existing.length > 0) throw new ApiError(409, 'EMAIL_IN_USE', 'An account with this email exists');

  const id = randomUUID();
  try {
    await db.insert(users).values({
      id,
      email,
      passwordHash: await hashPassword(input.password),
      name: input.name,
      locale: input.locale,
      timezone: input.timezone,
    });
  } catch {
    throw new ApiError(409, 'EMAIL_IN_USE', 'An account with this email exists');
  }

  const user = (await db.select().from(users).where(eq(users.id, id)).limit(1))[0]!;
  const tokens = await tokensFor(id);
  res.status(201).json({ user: publicUser(user), ...tokens });
});

router.post('/login', authLimiter, async (req, res) => {
  const input = loginSchema.parse(req.body);
  const email = input.email.toLowerCase();
  const rows = await db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = ${email}`)
    .limit(1);
  const user = rows[0];
  const ok = await bcrypt.compare(input.password, user?.passwordHash ?? dummyHash);
  if (!user || !ok) throw unauthorized('Invalid email or password');

  const tokens = await tokensFor(user.id);
  res.json({ user: publicUser(user), ...tokens });
});

router.post('/refresh', async (req, res) => {
  const input = refreshSchema.parse(req.body);
  const session = await findSessionByToken(input.refreshToken);
  if (!session) throw unauthorized('Refresh token is invalid or expired');
  // Rotate: a replayed token must stop working.
  await revokeSession(input.refreshToken);
  const rotated = await createSession(session.user.id);
  res.json({
    accessToken: await issueAccessToken(session.user.id, rotated.id),
    refreshToken: rotated.token,
  });
});

router.post('/logout', async (req, res) => {
  const parsed = refreshSchema.safeParse(req.body);
  if (parsed.success) await revokeSession(parsed.data.refreshToken);
  res.status(204).end();
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(me(req)) });
});

router.patch('/me', requireAuth, async (req, res) => {
  const user = me(req);
  const input = updateSchema.parse(req.body);
  if (input.timezone && !isValidTimezone(input.timezone)) throw badRequest('Invalid timezone');

  const rows = await db
    .update(users)
    .set({
      name: input.name ?? user.name,
      locale: input.locale ?? user.locale,
      timezone: input.timezone ?? user.timezone,
      theme: input.theme ?? user.theme,
      notificationsEnabled: input.notificationsEnabled ?? user.notificationsEnabled,
      updatedAt: new Date(),
    })
    .where(eq(users.id, user.id))
    .returning();
  res.json({ user: publicUser(rows[0]!) });
});

router.post('/change-password', requireAuth, authLimiter, async (req, res) => {
  const input = z
    .object({ currentPassword: z.string().min(1).max(72), newPassword: z.string().min(8).max(72) })
    .parse(req.body);
  const user = me(req);
  if (!(await verifyPassword(input.currentPassword, user.passwordHash))) {
    throw unauthorized('Current password is incorrect');
  }
  await db
    .update(users)
    .set({ passwordHash: await hashPassword(input.newPassword), updatedAt: new Date() })
    .where(eq(users.id, user.id));
  res.status(204).end();
});

export default router;
