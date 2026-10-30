import { DateTime } from 'luxon';
import { z } from 'zod';
import { config } from '../config.js';
import { notConfigured } from '../lib/errors.js';
import { formatDateTime } from '../lib/time.js';
import { visionJson } from './ai.js';

export const DOCUMENT_TYPES = [
  'electricity_bill',
  'water_bill',
  'school_fees',
  'insurance',
  'warranty',
  'vehicle_service',
  'subscription_invoice',
  'other',
] as const;

export type DocumentType = (typeof DOCUMENT_TYPES)[number];

const LABELS: Record<DocumentType, string> = {
  electricity_bill: 'Electricity bill',
  water_bill: 'Water bill',
  school_fees: 'School fees',
  insurance: 'Insurance',
  warranty: 'Warranty',
  vehicle_service: 'Vehicle service',
  subscription_invoice: 'Subscription invoice',
  other: 'Document',
};

const reminderCategory: Record<DocumentType, string> = {
  electricity_bill: 'electricity',
  water_bill: 'water',
  school_fees: 'school_fees',
  insurance: 'insurance',
  warranty: 'warranty',
  vehicle_service: 'vehicle_service',
  subscription_invoice: 'subscription',
  other: 'custom',
};

const flexibleNumber = z
  .union([z.number(), z.string(), z.null()])
  .optional()
  .transform((value) => {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(String(value).replace(/[^\d.-]/g, ''));
    return Number.isFinite(n) ? n : null;
  });

const flexibleDate = z
  .union([z.string(), z.null()])
  .optional()
  .transform((value) => {
    if (!value) return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    const iso = DateTime.fromISO(trimmed, { zone: 'utc' });
    if (iso.isValid) return iso.toFormat('yyyy-MM-dd');
    for (const format of ['dd/MM/yyyy', 'dd-MM-yyyy', 'd LLL yyyy', 'LLL d yyyy']) {
      const dt = DateTime.fromFormat(trimmed, format, { zone: 'utc' });
      if (dt.isValid) return dt.toFormat('yyyy-MM-dd');
    }
    return null;
  });

const extractionSchema = z.object({
  documentType: z
    .string()
    .optional()
    .default('other')
    .transform((v) => (DOCUMENT_TYPES.includes(v as DocumentType) ? (v as DocumentType) : 'other')),
  provider: z.union([z.string(), z.null()]).optional().transform((v) => (v?.trim() ? v.trim() : null)),
  amount: flexibleNumber,
  dueDate: flexibleDate,
  expiryDate: flexibleDate,
  reference: z.union([z.string(), z.null()]).optional().transform((v) => (v?.trim() ? v.trim() : null)),
  confidence: z
    .union([z.number(), z.string(), z.null()])
    .optional()
    .transform((v) => {
      const n = Number(v ?? 0);
      return Number.isFinite(n) ? (n > 1 ? n / 100 : Math.max(0, Math.min(1, n))) : 0;
    }),
  uncertainFields: z
    .union([z.array(z.string()), z.string(), z.null()])
    .optional()
    .transform((v) => {
      if (Array.isArray(v)) return v.map(String).slice(0, 20);
      if (typeof v === 'string' && v.trim()) return [v.trim()];
      return [];
    }),
});

export type Extraction = z.infer<typeof extractionSchema>;

export interface SuggestedReminder {
  title: string;
  category: string;
  dueAt: string;
  recurrence: 'once';
  advanceMinutes: number[];
  amount?: number;
}

const PROMPT = `Extract fields from this Indian household document. Return a JSON object with:
{
  "documentType": one of ${DOCUMENT_TYPES.join(', ')},
  "provider": company or department name or null,
  "amount": total payable as a number or null,
  "dueDate": payment due date as YYYY-MM-DD or null,
  "expiryDate": insurance/warranty expiry as YYYY-MM-DD or null,
  "reference": consumer number, policy number, invoice number or null,
  "confidence": 0 to 1 for your overall extraction confidence,
  "uncertainFields": array of field names that are blurry or ambiguous
}
Use null when you cannot read a value. Do not infer a due date that is not printed.`;

export async function extractDocument(buffer: Buffer, mimeType: string) {
  if (!config.AI_API_KEY) throw notConfigured('Document OCR', 'AI_API_KEY');
  const dataUrl = `data:${mimeType};base64,${buffer.toString('base64')}`;
  const raw = await visionJson(dataUrl, PROMPT);
  const parsed = extractionSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error('Could not read structured fields from this document');
  }
  const extraction = parsed.data;
  const confidence = extraction.confidence;
  const needsReview =
    confidence < 0.7 ||
    extraction.uncertainFields.length > 0 ||
    extraction.dueDate === null && extraction.expiryDate === null;
  return { ...extraction, confidence, needsReview, raw };
}

export function suggestedReminder(
  extraction: Extraction,
  timezone: string,
  now = new Date(),
): SuggestedReminder | null {
  const date = extraction.dueDate ?? extraction.expiryDate;
  if (!date) return null;

  const localDate = DateTime.fromISO(date, { zone: timezone }).set({ hour: 9, minute: 0 });
  if (!localDate.isValid || localDate.toJSDate() <= now) return null;

  const type = extraction.documentType;
  const label = LABELS[type];
  const title = `${extraction.dueDate ? label : `Expiry: ${label}`}${extraction.provider ? ` - ${extraction.provider}` : ''}`;
  const reminder: SuggestedReminder = {
    title: title.slice(0, 200),
    category: reminderCategory[type],
    dueAt: localDate.toUTC().toISO()!,
    recurrence: 'once',
    advanceMinutes: [extraction.dueDate ? 1440 : 10080],
  };
  if (extraction.amount !== null && extraction.amount > 0) reminder.amount = extraction.amount;
  return reminder;
}

export function documentTypeLabel(type: string | null) {
  return LABELS[(type as DocumentType) ?? 'other'] ?? LABELS.other;
}

export function suggestedReminderSummary(suggestion: SuggestedReminder, timezone: string, locale: string) {
  return `${suggestion.title} — ${formatDateTime(suggestion.dueAt, timezone, locale)}`;
}
