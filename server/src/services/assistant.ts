import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { memories, messages, pendingActions } from '../db/schema.js';
import type { UserRow } from '../lib/auth.js';
import { ApiError, badRequest, notFound } from '../lib/errors.js';
import {
  listRemindersPayloadSchema,
  memoryPayloadSchema,
  queryExpensesPayloadSchema,
  reminderPayloadSchema,
  expensePayloadSchema,
  WRITE_ACTIONS,
  type ActionType,
} from '../lib/schemas.js';
import { formatDateTime } from '../lib/time.js';
import {
  aiErrorSummary,
  chatWithTools,
  type AiMessage,
} from './ai.js';
import { expenseSummary, createExpense, expenseDto } from './expenses.js';
import {
  actionSummary,
  confirmationReply,
  formatMoney,
  strings,
} from './format.js';
import { detectLanguage, interpret, type Language } from './nlu.js';
import {
  createReminder,
  listReminders,
  reminderDto,
} from './reminders.js';

export interface PendingActionDto {
  id: string;
  type: string;
  summary: string;
  expiresAt: string;
}

export interface AssistantResponse {
  reply: string;
  language: Language;
  action?: PendingActionDto;
}

const localeFor = (language: Language) => (language === 'en' ? 'en' : 'ta');

function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== null && v !== undefined)
        .map(([k, v]) => [k, stripNulls(v)]),
    );
  }
  return value;
}

function systemPrompt(user: UserRow) {
  const now = DateTime.fromJSDate(new Date(), { zone: user.timezone }).toISO();
  return [
    'You are My Life AI, a warm and concise personal assistant for an Indian household.',
    'You help with household reminders, expenses, budgets, documents, and personal memory.',
    `Current date and time: ${now} (${user.timezone}).`,
    'If the user writes English, reply in English. If the user writes Tamil script or Tanglish, reply in simple Tamil script.',
    'Use tools for actions. For create_reminder, log_expense and remember the app will ask the user to confirm; never claim it is already saved.',
    'Ask one short question when a required detail is missing (for example the amount, or what to remind about). Do not invent dates, amounts, bills, places, or personal facts.',
    'All money is INR. Due dates and occurred dates must be ISO 8601 with a timezone offset.',
    'Keep replies short: one or two sentences, unless the user asks for a list.',
  ].join(' ');
}

async function historyFor(userId: string): Promise<AiMessage[]> {
  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.userId, userId))
    .orderBy(desc(messages.createdAt))
    .limit(10);
  return rows
    .reverse()
    .map((row) => ({ role: row.role === 'assistant' ? 'assistant' : 'user', content: row.content }));
}

interface ToolAction {
  type: ActionType;
  payload: Record<string, unknown>;
}

function actionFromTool(name: string, rawArguments: string): ToolAction | null {
  let args: unknown;
  try {
    args = stripNulls(JSON.parse(rawArguments));
  } catch {
    return null;
  }

  if (name === 'create_reminder') {
    const parsed = reminderPayloadSchema.safeParse(args);
    if (parsed.success) return { type: 'create_reminder', payload: parsed.data };
  }
  if (name === 'log_expense') {
    const parsed = expensePayloadSchema.safeParse(args);
    if (parsed.success) return { type: 'log_expense', payload: parsed.data };
  }
  if (name === 'remember') {
    const parsed = memoryPayloadSchema.safeParse(args);
    if (parsed.success) return { type: 'remember', payload: parsed.data };
  }
  if (name === 'query_expenses') {
    const parsed = queryExpensesPayloadSchema.safeParse(args);
    if (parsed.success) return { type: 'query_expenses', payload: parsed.data };
  }
  if (name === 'list_reminders') {
    const parsed = listRemindersPayloadSchema.safeParse(args);
    if (parsed.success) return { type: 'list_reminders', payload: parsed.data };
  }
  return null;
}

async function aiInterpret(
  user: UserRow,
  text: string,
): Promise<{ reply: string; action?: ToolAction } | null> {
  const history = await historyFor(user.id);
  const result = await chatWithTools([
    { role: 'system', content: systemPrompt(user) },
    ...history.slice(0, -1),
    { role: 'user', content: text },
  ]);
  const call = result.toolCalls[0];
  if (call) {
    const action = actionFromTool(call.name, call.arguments);
    if (action) return { reply: result.content ?? '', action };
    return null;
  }
  if (result.content) return { reply: result.content };
  return null;
}

function formatReminderList(rows: Array<ReturnType<typeof reminderDto>>, locale: string) {
  if (rows.length === 0) return strings.noUpcoming(locale);
  const heading =
    locale === 'ta' ? 'வரவிருக்கும் நினைவூட்டல்கள்:' : 'Here are your upcoming reminders:';
  const lines = rows.map(
    (r) => `• ${r.title} — ${formatDateTime(r.nextRunAt, r.timezone, locale)}`,
  );
  return [heading, ...lines].join('\n');
}

async function executeAction(user: UserRow, type: string, payload: Record<string, unknown>) {
  if (type === 'create_reminder') {
    const parsed = reminderPayloadSchema.parse(payload);
    const reminder = await createReminder(user, {
      title: parsed.title,
      category: parsed.category,
      startAt: parsed.dueAt,
      recurrence: parsed.recurrence,
      advanceMinutes: parsed.advanceMinutes,
      notes: parsed.notes,
      amount: parsed.amount,
    });
    return { kind: 'reminder' as const, reminder: reminderDto(reminder) };
  }
  if (type === 'log_expense') {
    const parsed = expensePayloadSchema.parse(payload);
    const expense = await createExpense(user, { ...parsed, source: 'ai' }, 'ai');
    return { kind: 'expense' as const, expense: expenseDto(expense) };
  }
  if (type === 'remember') {
    const parsed = memoryPayloadSchema.parse(payload);
    const rows = await db
      .insert(memories)
      .values({
        id: randomUUID(),
        userId: user.id,
        kind: parsed.kind,
        key: parsed.key,
        value: parsed.value,
        source: 'ai',
        confirmed: true,
      })
      .onConflictDoUpdate({
        target: [memories.userId, memories.key],
        set: {
          kind: parsed.kind,
          value: parsed.value,
          source: 'ai',
          confirmed: true,
          updatedAt: new Date(),
        },
      })
      .returning();
    return { kind: 'memory' as const, memory: rows[0] };
  }
  if (type === 'query_expenses') {
    const parsed = queryExpensesPayloadSchema.parse(payload);
    const summary = await expenseSummary(user, parsed.period);
    return { kind: 'summary' as const, summary };
  }
  if (type === 'list_reminders') {
    const parsed = listRemindersPayloadSchema.parse(payload);
    const rows = await listReminders(user.id, {
      status: parsed.scope === 'upcoming' ? 'active' : 'all',
      limit: 10,
    });
    return { kind: 'reminders' as const, reminders: rows.map((r) => reminderDto(r)) };
  }
  throw badRequest('Unsupported action');
}

export async function confirmAction(user: UserRow, id: string) {
  const rows = await db
    .select()
    .from(pendingActions)
    .where(and(eq(pendingActions.id, id), eq(pendingActions.userId, user.id)))
    .limit(1);
  const action = rows[0];
  if (!action) throw notFound('Confirmation');
  if (action.status !== 'pending') {
    throw new ApiError(409, 'ALREADY_HANDLED', 'This confirmation was already handled');
  }
  if (action.expiresAt < new Date()) {
    await db
      .update(pendingActions)
      .set({ status: 'expired' })
      .where(eq(pendingActions.id, id));
    throw new ApiError(410, 'EXPIRED', strings.expired(user.locale));
  }

  const result = await executeAction(user, action.type, action.payload);
  await db
    .update(pendingActions)
    .set({ status: 'confirmed', confirmedAt: new Date() })
    .where(eq(pendingActions.id, id));

  const note =
    result.kind === 'reminder'
      ? `${strings.saved(user.locale)} ${result.reminder.title}`
      : result.kind === 'expense'
        ? `${strings.saved(user.locale)} ${formatMoney(result.expense.amount, user.locale)} ${result.expense.category}`
        : result.kind === 'memory'
          ? `${strings.saved(user.locale)} ${result.memory?.key ?? ''}`
          : strings.saved(user.locale);
  await db.insert(messages).values({
    id: randomUUID(),
    userId: user.id,
    role: 'assistant',
    content: note,
    locale: user.locale,
    actionId: id,
  });

  return { reply: note, result };
}

export async function cancelAction(user: UserRow, id: string) {
  const rows = await db
    .select()
    .from(pendingActions)
    .where(and(eq(pendingActions.id, id), eq(pendingActions.userId, user.id)))
    .limit(1);
  const action = rows[0];
  if (!action) throw notFound('Confirmation');
  if (action.status !== 'pending') {
    throw new ApiError(409, 'ALREADY_HANDLED', 'This confirmation was already handled');
  }
  await db.update(pendingActions).set({ status: 'cancelled' }).where(eq(pendingActions.id, id));
  await db.insert(messages).values({
    id: randomUUID(),
    userId: user.id,
    role: 'assistant',
    content: strings.cancelled(user.locale),
    locale: user.locale,
    actionId: id,
  });
  return { reply: strings.cancelled(user.locale) };
}

export async function handleAssistantMessage(
  user: UserRow,
  text: string,
): Promise<AssistantResponse> {
  const language = detectLanguage(text);
  const locale = localeFor(language);

  await db.insert(messages).values({
    id: randomUUID(),
    userId: user.id,
    role: 'user',
    content: text,
    locale: language === 'en' ? 'en' : 'ta',
  });

  let reply = '';
  let action: ToolAction | undefined;

  if (config.aiEnabled) {
    try {
      const ai = await aiInterpret(user, text);
      if (ai) {
        reply = ai.reply;
        action = ai.action;
      }
    } catch (error) {
      console.warn(`AI fallback: ${aiErrorSummary(error)}`);
    }
  }

  if (!action && !reply) {
    const local = interpret(text, { timezone: user.timezone });
    reply = local.reply;
    if (local.action) action = { type: local.action.type, payload: local.action.payload };
  }

  if (action) {
    if (WRITE_ACTIONS.includes(action.type)) {
      const summary = actionSummary(action.type, action.payload, user.timezone, locale);
      const pending: PendingActionDto = {
        id: randomUUID(),
        type: action.type,
        summary,
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      };
      await db.insert(pendingActions).values({
        id: pending.id,
        userId: user.id,
        type: action.type,
        payload: action.payload,
        summary,
        status: 'pending',
        expiresAt: new Date(pending.expiresAt),
      });
      reply = confirmationReply(action.type, action.payload, user.timezone, locale);
      await db.insert(messages).values({
        id: randomUUID(),
        userId: user.id,
        role: 'assistant',
        content: reply,
        locale,
        actionId: pending.id,
      });
      return { reply, language, action: pending };
    }

    const result = await executeAction(user, action.type, action.payload);
    if (result.kind === 'summary') {
      reply = result.summary.insight || strings.noExpenses(locale);
    } else if (result.kind === 'reminders') {
      reply = formatReminderList(result.reminders, locale);
    }
  }

  if (!reply) reply = strings.genericError(locale);

  await db.insert(messages).values({
    id: randomUUID(),
    userId: user.id,
    role: 'assistant',
    content: reply,
    locale,
  });
  return { reply, language };
}

export async function assistantHistory(userId: string, limit = 50) {
  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.userId, userId))
    .orderBy(asc(messages.createdAt))
    .limit(Math.min(limit, 100));
  return rows.map((row) => ({
    id: row.id,
    role: row.role,
    content: row.content,
    actionId: row.actionId,
    createdAt: row.createdAt.toISOString(),
  }));
}
