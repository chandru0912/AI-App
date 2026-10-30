import { z } from 'zod';

export const REMINDER_CATEGORIES = [
  'electricity',
  'water',
  'rent',
  'loan_emi',
  'school_fees',
  'insurance',
  'subscription',
  'vehicle_service',
  'vehicle_insurance',
  'warranty',
  'custom',
] as const;

export const EXPENSE_CATEGORIES = [
  'Food',
  'Groceries',
  'Transportation',
  'Utilities',
  'Housing',
  'Health',
  'Education',
  'Shopping',
  'Entertainment',
  'Subscriptions',
  'Other',
  'Income',
] as const;

export const RECURRENCES = ['once', 'daily', 'weekly', 'monthly', 'yearly'] as const;

export const MEMORY_KINDS = ['date', 'preference', 'person', 'task', 'fact'] as const;

export const isoDateTime = z
  .string()
  .refine(
    (v) =>
      !Number.isNaN(Date.parse(v)) && /(?:Z|[+-]\d{2}:\d{2})$/.test(v),
    'Date/time must be ISO 8601 with a timezone offset',
  )
  .transform((v) => new Date(v).toISOString());

const isoDate = isoDateTime;

export const reminderPayloadSchema = z.object({
  title: z.string().trim().min(1).max(200),
  category: z.enum(REMINDER_CATEGORIES).default('custom'),
  dueAt: isoDate,
  recurrence: z.enum(RECURRENCES).default('once'),
  advanceMinutes: z.array(z.number().int().min(0).max(10080)).max(5).default([]),
  notes: z.string().trim().max(1000).optional(),
  amount: z.number().positive().max(10_000_000).optional(),
});
export type ReminderPayload = z.infer<typeof reminderPayloadSchema>;

export const expensePayloadSchema = z.object({
  type: z.enum(['expense', 'income']).default('expense'),
  amount: z.number().positive().max(10_000_000),
  category: z.enum(EXPENSE_CATEGORIES).default('Other'),
  note: z.string().trim().max(500).optional(),
  occurredAt: isoDate.optional(),
});
export type ExpensePayload = z.infer<typeof expensePayloadSchema>;

export const memoryPayloadSchema = z.object({
  kind: z.enum(MEMORY_KINDS).default('fact'),
  key: z.string().trim().min(1).max(120),
  value: z.string().trim().min(1).max(1000),
});
export type MemoryPayload = z.infer<typeof memoryPayloadSchema>;

export const queryExpensesPayloadSchema = z.object({
  period: z.enum(['day', 'week', 'month']).default('month'),
});
export type QueryExpensesPayload = z.infer<typeof queryExpensesPayloadSchema>;

export const listRemindersPayloadSchema = z.object({
  scope: z.enum(['upcoming', 'all']).default('upcoming'),
});
export type ListRemindersPayload = z.infer<typeof listRemindersPayloadSchema>;

export type ActionType =
  | 'create_reminder'
  | 'log_expense'
  | 'remember'
  | 'query_expenses'
  | 'list_reminders';

export const WRITE_ACTIONS: ActionType[] = ['create_reminder', 'log_expense', 'remember'];

export const reminderInputSchema = reminderPayloadSchema;

export const reminderCreateBodySchema = z.object({
  title: z.string().trim().min(1).max(200),
  category: z.enum(REMINDER_CATEGORIES).default('custom'),
  startAt: isoDate,
  recurrence: z.enum(RECURRENCES).default('once'),
  rrule: z.string().max(500).optional(),
  timezone: z.string().min(1).max(80).optional(),
  advanceMinutes: z.array(z.number().int().min(0).max(10080)).max(5).default([]),
  notes: z.string().trim().max(1000).optional(),
  amount: z.number().positive().max(10_000_000).optional(),
});

export const expenseCreateBodySchema = z.object({
  type: z.enum(['expense', 'income']).default('expense'),
  amount: z.number().positive().max(10_000_000),
  category: z.enum(EXPENSE_CATEGORIES).default('Other'),
  note: z.string().trim().max(500).optional(),
  occurredAt: isoDate.optional(),
  source: z.enum(['manual', 'ai', 'document']).default('manual'),
});

export const memoryCreateBodySchema = z.object({
  kind: z.enum(MEMORY_KINDS).default('fact'),
  key: z.string().trim().min(1).max(120),
  value: z.string().trim().min(1).max(1000),
});

export const budgetBodySchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  amount: z.number().min(0).max(10_000_000),
});

export function normalizeAdvance(values: number[]): number[] {
  return [...new Set(values)].filter((v) => v > 0).sort((a, b) => a - b);
}
