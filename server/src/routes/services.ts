import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { serviceReports } from '../db/schema.js';
import { me, requireAuth } from '../middleware/auth.js';
import { SERVICE_CATEGORIES, searchNearby, type ServiceCategory } from '../services/places.js';

const router = Router();
router.use(requireAuth);

const categorySchema = z.enum(Object.keys(SERVICE_CATEGORIES) as [ServiceCategory, ...ServiceCategory[]]);

router.get('/categories', (_req, res) => {
  res.json({
    categories: Object.entries(SERVICE_CATEGORIES).map(([id, query]) => ({ id, query })),
  });
});

router.get('/', async (req, res) => {
  const category = categorySchema.parse(req.query.category);
  const latitude = z.coerce.number().min(-90).max(90).parse(req.query.lat);
  const longitude = z.coerce.number().min(-180).max(180).parse(req.query.lng);
  const radius = req.query.radius ? z.coerce.number().min(500).max(20_000).parse(req.query.radius) : undefined;
  const providers = await searchNearby({
    latitude,
    longitude,
    category,
    radius,
    language: me(req).locale,
  });
  res.json({ providers });
});

router.post('/reports', async (req, res) => {
  const input = z
    .object({
      providerId: z.string().max(200).optional(),
      providerName: z.string().trim().min(1).max(200),
      reason: z.enum(['wrong_number', 'closed', 'poor_service', 'fake_listing', 'other']),
      details: z.string().trim().max(1000).optional(),
    })
    .parse(req.body);
  const rows = await db
    .insert(serviceReports)
    .values({
      id: randomUUID(),
      userId: me(req).id,
      providerId: input.providerId,
      providerName: input.providerName,
      reason: input.reason,
      details: input.details,
    })
    .returning({ id: serviceReports.id, createdAt: serviceReports.createdAt });
  res.status(201).json({ report: rows[0] });
});

router.get('/reports', async (req, res) => {
  const rows = await db
    .select()
    .from(serviceReports)
    .where(eq(serviceReports.userId, me(req).id))
    .orderBy(desc(serviceReports.createdAt))
    .limit(50);
  res.json({ reports: rows });
});

export default router;
