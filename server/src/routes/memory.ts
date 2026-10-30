import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { memories } from '../db/schema.js';
import { me, requireAuth } from '../middleware/auth.js';
import { notFound } from '../lib/errors.js';
import { MEMORY_KINDS, memoryCreateBodySchema } from '../lib/schemas.js';

const router = Router();
router.use(requireAuth);

const memoryDto = (row: typeof memories.$inferSelect) => ({
  id: row.id,
  kind: row.kind,
  key: row.key,
  value: row.value,
  source: row.source,
  confirmed: row.confirmed,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

router.get('/', async (req, res) => {
  const kind = z.enum(MEMORY_KINDS).optional().safeParse(req.query.kind);
  const rows = await db
    .select()
    .from(memories)
    .where(eq(memories.userId, me(req).id))
    .orderBy(asc(memories.key));
  const filtered = kind.success && kind.data ? rows.filter((row) => row.kind === kind.data) : rows;
  res.json({ memories: filtered.map(memoryDto) });
});

router.post('/', async (req, res) => {
  const input = memoryCreateBodySchema.parse(req.body);
  const rows = await db
    .insert(memories)
    .values({
      id: randomUUID(),
      userId: me(req).id,
      kind: input.kind,
      key: input.key,
      value: input.value,
      source: 'user',
      confirmed: true,
    })
    .onConflictDoUpdate({
      target: [memories.userId, memories.key],
      set: {
        kind: input.kind,
        value: input.value,
        source: 'user',
        confirmed: true,
        updatedAt: new Date(),
      },
    })
    .returning();
  res.status(201).json({ memory: memoryDto(rows[0]!) });
});

router.patch('/:id', async (req, res) => {
  const input = z
    .object({
      kind: z.enum(MEMORY_KINDS).optional(),
      key: z.string().trim().min(1).max(120).optional(),
      value: z.string().trim().min(1).max(1000).optional(),
    })
    .parse(req.body);
  const userId = me(req).id;
  const existing = (
    await db
      .select()
      .from(memories)
      .where(and(eq(memories.id, req.params.id), eq(memories.userId, userId)))
      .limit(1)
  )[0];
  if (!existing) throw notFound('Memory');
  const rows = await db
    .update(memories)
    .set({
      kind: input.kind ?? existing.kind,
      key: input.key ?? existing.key,
      value: input.value ?? existing.value,
      updatedAt: new Date(),
    })
    .where(and(eq(memories.id, req.params.id), eq(memories.userId, userId)))
    .returning();
  res.json({ memory: memoryDto(rows[0]!) });
});

router.delete('/:id', async (req, res) => {
  const userId = me(req).id;
  const rows = await db
    .delete(memories)
    .where(and(eq(memories.id, req.params.id), eq(memories.userId, userId)))
    .returning({ id: memories.id });
  if (rows.length === 0) throw notFound('Memory');
  res.status(204).end();
});

export default router;
