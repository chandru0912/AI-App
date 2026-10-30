import { randomUUID } from 'node:crypto';
import { and, desc, eq, gte, lte } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { budgets, expenses } from '../db/schema.js';
import type { UserRow } from '../lib/auth.js';
import { badRequest, notFound } from '../lib/errors.js';
import { expenseCreateBodySchema } from '../lib/schemas.js';
import { periodRange, type Period } from '../lib/time.js';
import { chatText } from './ai.js';
import { formatMoney } from './format.js';

type ExpenseRow = typeof expenses.$inferSelect;
type CreateBody = z.infer<typeof expenseCreateBodySchema>;

export interface ExpenseDto {
  id: string;
  type: string;
  amount: number;
  category: string;
  note: string | null;
  occurredAt: string;
  source: string;
  createdAt: string;
}

export const expenseDto = (row: ExpenseRow): ExpenseDto => ({
  id: row.id,
  type: row.type,
  amount: Number(row.amount),
  category: row.category,
  note: row.note,
  occurredAt: row.occurredAt.toISOString(),
  source: row.source,
  createdAt: row.createdAt.toISOString(),
});

export async function createExpense(
  user: UserRow,
  input: CreateBody,
  source: 'manual' | 'ai' | 'document' = input.source,
): Promise<ExpenseRow> {
  const rows = await db
    .insert(expenses)
    .values({
      id: randomUUID(),
      userId: user.id,
      type: input.type,
      amount: String(input.amount),
      category: input.category,
      note: input.note,
      occurredAt: input.occurredAt ? new Date(input.occurredAt) : new Date(),
      source,
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('Failed to create expense');
  return row;
}

export async function listExpenses(
  userId: string,
  options: {
    from?: Date;
    to?: Date;
    category?: string;
    type?: string;
    limit?: number;
  } = {},
) {
  const filters = [eq(expenses.userId, userId)];
  if (options.from) filters.push(gte(expenses.occurredAt, options.from));
  if (options.to) filters.push(lte(expenses.occurredAt, options.to));
  if (options.category) filters.push(eq(expenses.category, options.category));
  if (options.type) filters.push(eq(expenses.type, options.type));
  return db
    .select()
    .from(expenses)
    .where(and(...filters))
    .orderBy(desc(expenses.occurredAt))
    .limit(Math.min(options.limit ?? 100, 200));
}

export async function getOwnedExpense(userId: string, id: string) {
  const rows = await db
    .select()
    .from(expenses)
    .where(and(eq(expenses.id, id), eq(expenses.userId, userId)))
    .limit(1);
  const row = rows[0];
  if (!row) throw notFound('Expense');
  return row;
}

export async function updateExpense(
  userId: string,
  id: string,
  patch: {
    type?: string;
    amount?: number;
    category?: string;
    note?: string | null;
    occurredAt?: string;
  },
) {
  const existing = await getOwnedExpense(userId, id);
  const rows = await db
    .update(expenses)
    .set({
      type: patch.type ?? existing.type,
      amount: patch.amount === undefined ? existing.amount : String(patch.amount),
      category: patch.category ?? existing.category,
      note: patch.note === undefined ? existing.note : patch.note,
      occurredAt: patch.occurredAt ? new Date(patch.occurredAt) : existing.occurredAt,
      updatedAt: new Date(),
    })
    .where(and(eq(expenses.id, id), eq(expenses.userId, userId)))
    .returning();
  const row = rows[0];
  if (!row) throw notFound('Expense');
  return row;
}

export async function deleteExpense(userId: string, id: string) {
  await getOwnedExpense(userId, id);
  await db.delete(expenses).where(and(eq(expenses.id, id), eq(expenses.userId, userId)));
}

export async function setBudget(user: UserRow, month: string, amount: number) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw badRequest('Month must be YYYY-MM');
  const rows = await db
    .insert(budgets)
    .values({
      id: randomUUID(),
      userId: user.id,
      month,
      amount: String(amount),
    })
    .onConflictDoUpdate({
      target: [budgets.userId, budgets.month],
      set: { amount: String(amount), updatedAt: new Date() },
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('Failed to save budget');
  return { month: row.month, amount: Number(row.amount) };
}

export async function getBudget(userId: string, month: string) {
  const rows = await db
    .select()
    .from(budgets)
    .where(and(eq(budgets.userId, userId), eq(budgets.month, month)))
    .limit(1);
  const row = rows[0];
  return row ? { month: row.month, amount: Number(row.amount) } : null;
}

export interface ExpenseSummary {
  period: Period;
  from: string;
  to: string;
  label: string;
  income: number;
  expenses: number;
  net: number;
  budget: { amount: number; spent: number; remaining: number; percent: number } | null;
  byCategory: Array<{ category: string; amount: number; percent: number }>;
  daily: Array<{ date: string; amount: number }>;
  insight: string;
}

function ruleInsight(
  summary: Omit<ExpenseSummary, 'insight'>,
  locale: string,
  currency: (n: number) => string,
) {
  const ta = locale === 'ta';
  if (summary.expenses === 0 && summary.income === 0) {
    return ta
      ? 'இந்த காலத்தில் செலவு அல்லது வருமானம் பதிவாகவில்லை.'
      : 'No expenses or income recorded in this period.';
  }
  const top = summary.byCategory[0];
  const parts: string[] = [];
  if (ta) {
    parts.push(`இந்த காலத்தில் மொத்த செலவு ${currency(summary.expenses)}.`);
    if (summary.income > 0) parts.push(`வருமானம் ${currency(summary.income)}.`);
    if (top) parts.push(`அதிக செலவு ${top.category} — ${currency(top.amount)}.`);
    if (summary.budget) {
      parts.push(
        summary.budget.remaining >= 0
          ? `மாத பட்ஜெட்டில் ${currency(summary.budget.remaining)} மீதம் உள்ளது.`
          : `மாத பட்ஜெட்டை ${currency(Math.abs(summary.budget.remaining))} தாண்டிவிட்டீர்கள்.`,
      );
    }
  } else {
    parts.push(`You spent ${currency(summary.expenses)} this period.`);
    if (summary.income > 0) parts.push(`Income was ${currency(summary.income)}.`);
    if (top) parts.push(`Top category: ${top.category} at ${currency(top.amount)}.`);
    if (summary.budget) {
      parts.push(
        summary.budget.remaining >= 0
          ? `${currency(summary.budget.remaining)} left in your monthly budget.`
          : `You are over your monthly budget by ${currency(Math.abs(summary.budget.remaining))}.`,
      );
    }
  }
  return parts.join(' ');
}

export async function expenseSummary(
  user: UserRow,
  period: Period,
  locale = user.locale,
): Promise<ExpenseSummary> {
  const range = periodRange(period, user.timezone);
  const rows = await listExpenses(user.id, {
    from: range.from,
    to: new Date(range.to.getTime() - 1),
    limit: 200,
  });
  const budget = await getBudget(user.id, range.month);
  const monthStart = DateTime.fromJSDate(new Date(), { zone: user.timezone })
    .startOf('month')
    .toUTC()
    .toJSDate();
  const monthRows = await listExpenses(user.id, {
    from: monthStart,
    to: new Date(),
    type: 'expense',
    limit: 200,
  });
  const monthSpent = monthRows.reduce((sum, row) => sum + Number(row.amount), 0);

  let income = 0;
  let totalExpenses = 0;
  const categoryTotals = new Map<string, number>();
  const dailyTotals = new Map<string, number>();

  for (const row of rows) {
    const amount = Number(row.amount);
    const day = DateTime.fromJSDate(row.occurredAt, { zone: user.timezone }).toFormat('yyyy-MM-dd');
    if (row.type === 'income') {
      income += amount;
    } else {
      totalExpenses += amount;
      categoryTotals.set(row.category, (categoryTotals.get(row.category) ?? 0) + amount);
      dailyTotals.set(day, (dailyTotals.get(day) ?? 0) + amount);
    }
  }

  const byCategory = [...categoryTotals.entries()]
    .map(([category, amount]) => ({
      category,
      amount: Math.round(amount * 100) / 100,
      percent: totalExpenses > 0 ? Math.round((amount / totalExpenses) * 100) : 0,
    }))
    .sort((a, b) => b.amount - a.amount);

  const daily: Array<{ date: string; amount: number }> = [];
  const start = DateTime.fromJSDate(range.from, { zone: user.timezone });
  const days = period === 'day' ? 1 : period === 'week' ? 7 : (start.daysInMonth ?? 30);
  for (let i = 0; i < days; i += 1) {
    const day = start.plus({ days: i }).toFormat('yyyy-MM-dd');
    daily.push({ date: day, amount: Math.round((dailyTotals.get(day) ?? 0) * 100) / 100 });
  }

  const budgetInfo = budget
    ? {
        amount: budget.amount,
        spent: Math.round(monthSpent * 100) / 100,
        remaining: Math.round((budget.amount - monthSpent) * 100) / 100,
        percent: budget.amount > 0 ? Math.round((monthSpent / budget.amount) * 100) : 0,
      }
    : null;

  const base = {
    period,
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    label: range.label,
    income: Math.round(income * 100) / 100,
    expenses: Math.round(totalExpenses * 100) / 100,
    net: Math.round((income - totalExpenses) * 100) / 100,
    budget: budgetInfo,
    byCategory,
    daily,
  };

  const currency = (n: number) => formatMoney(n, locale);
  let insight = ruleInsight(base, locale, currency);

  if (config.aiEnabled && rows.length > 0) {
    try {
      const generated = await chatText([
        {
          role: 'system',
          content: `You are a concise personal finance assistant for an Indian household. Reply in ${locale === 'ta' ? 'Tamil script' : 'English'} in at most two short sentences. Use INR. Do not invent data and do not give investment advice.`,
        },
        {
          role: 'user',
          content: `Summarize this spending: ${JSON.stringify({
            label: base.label,
            income: base.income,
            expenses: base.expenses,
            topCategories: base.byCategory.slice(0, 4),
            budget: base.budget,
          })}`,
        },
      ]);
      if (generated) insight = generated;
    } catch {
      // Deterministic insight is the fallback; the dashboard must never fail because AI is down.
    }
  }

  return { ...base, insight };
}
