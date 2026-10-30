import { Router } from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { documents } from '../db/schema.js';
import { me, requireAuth } from '../middleware/auth.js';
import { badRequest, notConfigured, notFound } from '../lib/errors.js';
import { documentEncryptionAvailable, decryptBuffer, encryptBuffer } from '../lib/crypto.js';
import {
  DOCUMENT_TYPES,
  documentTypeLabel,
  extractDocument,
  suggestedReminder,
} from '../services/ocr.js';
import { createReminder, reminderDto } from '../services/reminders.js';
import { reminderCreateBodySchema } from '../lib/schemas.js';

const router = Router();
router.use(requireAuth);

const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp']);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED.has(file.mimetype)) {
      cb(badRequest('Upload a JPEG, PNG, or WebP photo of the document'));
      return;
    }
    cb(null, true);
  },
});

type DocumentRow = typeof documents.$inferSelect;

const dto = (row: DocumentRow) => ({
  id: row.id,
  status: row.status,
  originalName: row.originalName,
  mimeType: row.mimeType,
  documentType: row.documentType,
  documentTypeLabel: documentTypeLabel(row.documentType),
  provider: row.provider,
  amount: row.amount === null ? null : Number(row.amount),
  dueAt: row.dueAt?.toISOString() ?? null,
  expiresAt: row.expiresAt?.toISOString() ?? null,
  reference: row.reference,
  confidence: row.confidence === null ? null : Number(row.confidence),
  extracted: row.extracted,
  reminderId: row.reminderId,
  fileUrl: `/documents/${row.id}/file`,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

router.post(
  '/scan',
  (_req, _res, next) => {
    if (!config.AI_API_KEY) return next(notConfigured('Document OCR', 'AI_API_KEY'));
    if (!documentEncryptionAvailable()) {
      return next(notConfigured('Encrypted document storage', 'DOCUMENT_ENCRYPTION_KEY'));
    }
    next();
  },
  upload.single('file'),
  async (req, res) => {
    const user = me(req);
    if (!req.file) throw badRequest('Attach a document photo as "file"');

    const extraction = await extractDocument(req.file.buffer, req.file.mimetype);
    const id = randomUUID();
    const dir = join(config.UPLOAD_DIR, user.id);
    const storagePath = join(dir, `${id}.bin`);
    await mkdir(dir, { recursive: true });
    await writeFile(storagePath, encryptBuffer(req.file.buffer));

    const dueAt = extraction.dueDate ? new Date(`${extraction.dueDate}T09:00:00Z`) : null;
    const expiresAt = extraction.expiryDate ? new Date(`${extraction.expiryDate}T09:00:00Z`) : null;
    try {
      const rows = await db
        .insert(documents)
        .values({
          id,
          userId: user.id,
          status: extraction.needsReview ? 'review' : 'extracted',
          originalName: req.file.originalname.slice(0, 200),
          mimeType: req.file.mimetype,
          storagePath,
          documentType: extraction.documentType,
          provider: extraction.provider,
          amount: extraction.amount === null ? null : String(extraction.amount),
          dueAt,
          expiresAt,
          reference: extraction.reference,
          extracted: extraction.raw,
          confidence: String(extraction.confidence),
        })
        .returning();
      const row = rows[0]!;
      res.status(201).json({
        document: dto(row),
        extraction,
        needsReview: extraction.needsReview,
        suggestedReminder: suggestedReminder(extraction, user.timezone),
      });
    } catch (error) {
      await rm(storagePath, { force: true });
      throw error;
    }
  },
);

router.get('/', async (req, res) => {
  const rows = await db
    .select()
    .from(documents)
    .where(eq(documents.userId, me(req).id))
    .orderBy(desc(documents.createdAt))
    .limit(100);
  res.json({ documents: rows.map(dto) });
});

router.get('/:id', async (req, res) => {
  const rows = await db
    .select()
    .from(documents)
    .where(and(eq(documents.id, req.params.id), eq(documents.userId, me(req).id)))
    .limit(1);
  const row = rows[0];
  if (!row) throw notFound('Document');
  res.json({
    document: dto(row),
    suggestedReminder: suggestedReminder(
      {
        documentType: (row.documentType ?? 'other') as (typeof DOCUMENT_TYPES)[number],
        provider: row.provider,
        amount: row.amount === null ? null : Number(row.amount),
        dueDate: row.dueAt ? row.dueAt.toISOString().slice(0, 10) : null,
        expiryDate: row.expiresAt ? row.expiresAt.toISOString().slice(0, 10) : null,
        reference: row.reference,
        confidence: row.confidence === null ? 0 : Number(row.confidence),
        uncertainFields: [],
      },
      me(req).timezone,
    ),
  });
});

router.get('/:id/file', async (req, res) => {
  const rows = await db
    .select()
    .from(documents)
    .where(and(eq(documents.id, req.params.id), eq(documents.userId, me(req).id)))
    .limit(1);
  const row = rows[0];
  if (!row) throw notFound('Document');
  if (!documentEncryptionAvailable()) {
    throw notConfigured('Encrypted document storage', 'DOCUMENT_ENCRYPTION_KEY');
  }
  const sealed = await readFile(row.storagePath).catch(() => null);
  if (!sealed) throw notFound('Document file');
  res.setHeader('Content-Type', row.mimeType);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Disposition', `inline; filename="document-${row.id}"`);
  res.send(decryptBuffer(sealed));
});

const reviewSchema = z.object({
  documentType: z.enum(DOCUMENT_TYPES).optional(),
  provider: z.string().trim().max(200).nullable().optional(),
  amount: z.number().positive().max(10_000_000).nullable().optional(),
  dueAt: z.string().datetime({ offset: true }).nullable().optional(),
  expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
  reference: z.string().trim().max(120).nullable().optional(),
});

router.patch('/:id', async (req, res) => {
  const input = reviewSchema.parse(req.body);
  const user = me(req);
  const existing = (
    await db
      .select()
      .from(documents)
      .where(and(eq(documents.id, req.params.id), eq(documents.userId, user.id)))
      .limit(1)
  )[0];
  if (!existing) throw notFound('Document');

  const rows = await db
    .update(documents)
    .set({
      documentType: input.documentType ?? existing.documentType,
      provider: input.provider === undefined ? existing.provider : input.provider,
      amount:
        input.amount === undefined
          ? existing.amount
          : input.amount === null
            ? null
            : String(input.amount),
      dueAt: input.dueAt === undefined ? existing.dueAt : input.dueAt ? new Date(input.dueAt) : null,
      expiresAt:
        input.expiresAt === undefined
          ? existing.expiresAt
          : input.expiresAt
            ? new Date(input.expiresAt)
            : null,
      reference: input.reference === undefined ? existing.reference : input.reference,
      status: 'review',
      updatedAt: new Date(),
    })
    .where(and(eq(documents.id, req.params.id), eq(documents.userId, user.id)))
    .returning();
  res.json({ document: dto(rows[0]!) });
});

router.post('/:id/confirm', async (req, res) => {
  const input = z.object({ reminder: reminderCreateBodySchema.optional() }).parse(req.body);
  const user = me(req);
  const existing = (
    await db
      .select()
      .from(documents)
      .where(and(eq(documents.id, req.params.id), eq(documents.userId, user.id)))
      .limit(1)
  )[0];
  if (!existing) throw notFound('Document');

  const reminder = input.reminder ? await createReminder(user, input.reminder) : null;
  const rows = await db
    .update(documents)
    .set({
      status: 'confirmed',
      reminderId: reminder?.id ?? existing.reminderId,
      updatedAt: new Date(),
    })
    .where(and(eq(documents.id, req.params.id), eq(documents.userId, user.id)))
    .returning();
  res.json({
    document: dto(rows[0]!),
    reminder: reminder ? reminderDto(reminder) : null,
  });
});

router.delete('/:id', async (req, res) => {
  const user = me(req);
  const rows = await db
    .delete(documents)
    .where(and(eq(documents.id, req.params.id), eq(documents.userId, user.id)))
    .returning({ storagePath: documents.storagePath });
  const row = rows[0];
  if (!row) throw notFound('Document');
  await rm(row.storagePath, { force: true });
  res.status(204).end();
});

export { MAX_BYTES };
export default router;
