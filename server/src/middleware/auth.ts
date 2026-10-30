import type { NextFunction, Request, Response } from 'express';
import { findUserBySession, verifyAccessToken, type UserRow } from '../lib/auth.js';
import { unauthorized } from '../lib/errors.js';

declare module 'express-serve-static-core' {
  interface Request {
    user?: UserRow;
  }
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw unauthorized();
    const claims = await verifyAccessToken(header.slice(7));
    if (!claims) throw unauthorized('Invalid or expired token');
    const user = await findUserBySession(claims.userId, claims.sessionId);
    if (!user) throw unauthorized('Session expired');
    req.user = user;
    next();
  } catch {
    next(unauthorized('Invalid or expired token'));
  }
}

export function me(req: Request): UserRow {
  if (!req.user) throw unauthorized();
  return req.user;
}
