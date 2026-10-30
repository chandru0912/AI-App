import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { sessions, users } from '../db/schema.js';
import { randomToken, sha256 } from './crypto.js';

const secret = new TextEncoder().encode(config.JWT_SECRET);
const ISSUER = 'my-life-ai';
const AUDIENCE = 'my-life-ai-mobile';
const REFRESH_DAYS = 60;

export type UserRow = typeof users.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;

export const publicUser = (user: UserRow) => ({
  id: user.id,
  email: user.email,
  name: user.name,
  locale: user.locale,
  timezone: user.timezone,
  theme: user.theme,
  notificationsEnabled: user.notificationsEnabled,
  createdAt: user.createdAt,
});

export async function hashPassword(password: string) {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string) {
  return bcrypt.compare(password, hash);
}

// Used to keep login timing similar when the email does not exist.
export const dummyHash = '$2b$12$qnuIpeVlejeN7u3e7XxqFOYcC44uuxwFbluYEla1SRkrcKgCB9n3.';

export async function issueAccessToken(userId: string, sessionId: string) {
  return new SignJWT({ sid: sessionId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(secret);
}

export async function verifyAccessToken(token: string) {
  const { payload } = await jwtVerify(token, secret, { issuer: ISSUER, audience: AUDIENCE });
  if (!payload.sub || typeof payload.sid !== 'string') return null;
  return { userId: payload.sub, sessionId: payload.sid };
}

export async function createSession(userId: string) {
  const token = randomToken();
  const expiresAt = DateTime.utc().plus({ days: REFRESH_DAYS }).toJSDate();
  const id = randomUUID();
  await db.insert(sessions).values({ id, userId, tokenHash: sha256(token), expiresAt });
  return { id, token, expiresAt };
}

export async function findSessionByToken(token: string) {
  const hash = sha256(token);
  const rows = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(eq(sessions.tokenHash, hash), isNull(sessions.revokedAt), gt(sessions.expiresAt, new Date())),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function revokeSession(token: string) {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(eq(sessions.tokenHash, sha256(token)));
}

export async function findUserBySession(userId: string, sessionId: string) {
  const rows = await db
    .select({ user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        eq(sessions.id, sessionId),
        eq(sessions.userId, userId),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return rows[0]?.user ?? null;
}
