import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

const id = () => text('id').primaryKey();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

export const users = pgTable(
  'users',
  {
    id: id(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    name: text('name').notNull(),
    locale: text('locale').notNull().default('en'),
    timezone: text('timezone').notNull().default('Asia/Kolkata'),
    theme: text('theme').notNull().default('dark'),
    notificationsEnabled: boolean('notifications_enabled').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('users_email_lower_idx').on(sql`lower(${t.email})`)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

export const devices = pgTable(
  'devices',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expoPushToken: text('expo_push_token').notNull().unique(),
    platform: text('platform').notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [index('devices_user_idx').on(t.userId)],
);

export const reminders = pgTable(
  'reminders',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    notes: text('notes'),
    category: text('category').notNull().default('custom'),
    amount: numeric('amount', { precision: 12, scale: 2 }),
    startAt: timestamp('start_at', { withTimezone: true }).notNull(),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }).notNull(),
    rrule: text('rrule'),
    timezone: text('timezone').notNull(),
    advanceMinutes: jsonb('advance_minutes')
      .$type<number[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    status: text('status').notNull().default('active'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('reminders_due_idx').on(t.userId, t.status, t.nextRunAt),
    index('reminders_user_idx').on(t.userId, t.createdAt),
  ],
);

export const reminderEvents = pgTable(
  'reminder_events',
  {
    id: id(),
    reminderId: text('reminder_id')
      .notNull()
      .references(() => reminders.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    occurrenceAt: timestamp('occurrence_at', { withTimezone: true }).notNull(),
    action: text('action').notNull(),
    note: text('note'),
    createdAt: createdAt(),
  },
  (t) => [index('reminder_events_reminder_idx').on(t.reminderId, t.createdAt)],
);

export const notifications = pgTable(
  'notifications',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    reminderId: text('reminder_id').references(() => reminders.id, { onDelete: 'set null' }),
    occurrenceAt: timestamp('occurrence_at', { withTimezone: true }),
    offsetMinutes: integer('offset_minutes').notNull().default(0),
    kind: text('kind').notNull().default('reminder'),
    dedupeKey: text('dedupe_key').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }).notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    pushTicketId: text('push_ticket_id'),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('notifications_dedupe_idx').on(t.dedupeKey),
    index('notifications_user_idx').on(t.userId, t.createdAt),
  ],
);

export const expenses = pgTable(
  'expenses',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull().default('expense'),
    amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
    category: text('category').notNull().default('Other'),
    note: text('note'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    source: text('source').notNull().default('manual'),
    documentId: text('document_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('expenses_user_date_idx').on(t.userId, t.occurredAt),
    index('expenses_user_category_idx').on(t.userId, t.category),
  ],
);

export const budgets = pgTable(
  'budgets',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    month: text('month').notNull(),
    amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('budgets_user_month_idx').on(t.userId, t.month)],
);

export const memories = pgTable(
  'memories',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull().default('fact'),
    key: text('key').notNull(),
    value: text('value').notNull(),
    source: text('source').notNull().default('user'),
    confirmed: boolean('confirmed').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('memories_user_key_idx').on(t.userId, t.key)],
);

export const documents = pgTable(
  'documents',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('pending'),
    originalName: text('original_name').notNull(),
    mimeType: text('mime_type').notNull(),
    storagePath: text('storage_path').notNull(),
    documentType: text('document_type'),
    provider: text('provider'),
    amount: numeric('amount', { precision: 12, scale: 2 }),
    dueAt: timestamp('due_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    reference: text('reference'),
    extracted: jsonb('extracted').$type<Record<string, unknown>>(),
    confidence: numeric('confidence', { precision: 4, scale: 3 }),
    reminderId: text('reminder_id').references(() => reminders.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('documents_user_idx').on(t.userId, t.createdAt)],
);

export const pendingActions = pgTable(
  'pending_actions',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    summary: text('summary').notNull(),
    status: text('status').notNull().default('pending'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('pending_actions_user_idx').on(t.userId, t.status, t.createdAt)],
);

export const messages = pgTable(
  'messages',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    content: text('content').notNull(),
    locale: text('locale'),
    actionId: text('action_id'),
    createdAt: createdAt(),
  },
  (t) => [index('messages_user_idx').on(t.userId, t.createdAt)],
);

export const serviceReports = pgTable(
  'service_reports',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    providerId: text('provider_id'),
    providerName: text('provider_name').notNull(),
    reason: text('reason').notNull(),
    details: text('details'),
    status: text('status').notNull().default('open'),
    createdAt: createdAt(),
  },
  (t) => [index('service_reports_user_idx').on(t.userId, t.createdAt)],
);

export const schema = {
  users,
  sessions,
  devices,
  reminders,
  reminderEvents,
  notifications,
  expenses,
  budgets,
  memories,
  documents,
  pendingActions,
  messages,
  serviceReports,
};
