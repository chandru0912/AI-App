process.env.NODE_ENV = 'test';
process.env.PGLITE_DIR = 'memory://';
process.env.JWT_SECRET = 'test-secret-that-is-longer-than-thirty-two-characters';
process.env.DOCUMENT_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.AUTO_MIGRATE = 'false';
process.env.SCHEDULER_ENABLED = 'false';
process.env.AI_API_KEY = '';
process.env.GOOGLE_PLACES_API_KEY = '';

import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';

const { createApp } = await import('../src/app.js');
const { migrate } = await import('../src/db/migrate.js');
const { closeDb } = await import('../src/db/index.js');

const app = createApp();
const server = app.listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
await migrate();

let accessToken = '';
let refreshToken = '';

async function call(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
  if (init.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  const res = await fetch(`${base}${path}`, { ...init, headers });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  return { status: res.status, json };
}

const email = `test-${Date.now()}@example.com`;
const password = 'correct horse battery';

test('health reports missing optional integrations', async () => {
  const { status, json } = await call('/health');
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.ai, false);
  assert.equal(json.places, false);
});

test('allows local and LAN dev origins, rejects public origins', async () => {
  const lan = await fetch(`${base}/health`, { headers: { Origin: 'http://192.168.1.50:8081' } });
  assert.equal(lan.status, 200);
  assert.equal(lan.headers.get('access-control-allow-origin'), 'http://192.168.1.50:8081');

  const altPort = await fetch(`${base}/health`, { headers: { Origin: 'http://localhost:8082' } });
  assert.equal(altPort.status, 200);
  assert.equal(altPort.headers.get('access-control-allow-origin'), 'http://localhost:8082');

  const publicOrigin = await fetch(`${base}/health`, { headers: { Origin: 'https://example.com' } });
  assert.equal(publicOrigin.status, 403);
});

test('registers, reads and updates the account', async () => {
  const registered = await call('/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      email,
      password,
      name: 'Test User',
      locale: 'en',
      timezone: 'Asia/Kolkata',
    }),
  });
  assert.equal(registered.status, 201);
  accessToken = registered.json.accessToken;
  refreshToken = registered.json.refreshToken;
  assert.equal(registered.json.user.name, 'Test User');

  const me = await call('/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.json.user.email, email);

  const patched = await call('/auth/me', {
    method: 'PATCH',
    body: JSON.stringify({ locale: 'ta', notificationsEnabled: false }),
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.user.locale, 'ta');
});

test('creates reminders with recurrence and records completion', async () => {
  const startAt = new Date(Date.now() + 86_400_000).toISOString();
  const created = await call('/reminders', {
    method: 'POST',
    body: JSON.stringify({
      title: 'Pay EB bill',
      category: 'electricity',
      startAt,
      recurrence: 'monthly',
      advanceMinutes: [1440],
      amount: 850,
    }),
  });
  assert.equal(created.status, 201);
  const reminder = created.json.reminder;
  assert.equal(reminder.title, 'Pay EB bill');
  assert.equal(reminder.advanceMinutes[0], 1440);
  assert.ok(reminder.upcoming.length >= 2);

  const listed = await call('/reminders');
  assert.equal(listed.status, 200);
  assert.ok(listed.json.reminders.some((r: { id: string }) => r.id === reminder.id));

  const completed = await call(`/reminders/${reminder.id}/complete`, { method: 'POST' });
  assert.equal(completed.status, 200);
  assert.equal(completed.json.reminder.status, 'active');
  assert.notEqual(completed.json.reminder.nextRunAt, reminder.nextRunAt);

  const history = await call(`/reminders/${reminder.id}/history`);
  assert.equal(history.status, 200);
  assert.ok(history.json.history.some((h: { action: string }) => h.action === 'completed'));

  const bad = await call('/reminders', {
    method: 'POST',
    body: JSON.stringify({ title: 'Past', startAt: '2020-01-01T09:00:00+05:30' }),
  });
  assert.equal(bad.status, 400);
});

test('assistant confirmation gate saves a reminder only after confirm', async () => {
  const response = await call('/assistant/messages', {
    method: 'POST',
    body: JSON.stringify({ text: 'Remind me to pay water bill tomorrow at 10 am' }),
  });
  assert.equal(response.status, 200);
  assert.ok(response.json.action, 'expected a pending confirmation');
  const actionId = response.json.action.id;

  const before = await call('/reminders');
  const countBefore = before.json.reminders.length;

  const confirmed = await call(`/assistant/actions/${actionId}/confirm`, { method: 'POST' });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.json.result.kind, 'reminder');

  const after = await call('/reminders');
  assert.equal(after.json.reminders.length, countBefore + 1);

  const again = await call(`/assistant/actions/${actionId}/confirm`, { method: 'POST' });
  assert.equal(again.status, 409);

  const expense = await call('/assistant/messages', {
    method: 'POST',
    body: JSON.stringify({ text: 'I spent 120 rupees on lunch today' }),
  });
  assert.equal(expense.status, 200);
  assert.ok(expense.json.action);
  const confirmedExpense = await call(`/assistant/actions/${expense.json.action.id}/confirm`, {
    method: 'POST',
  });
  assert.equal(confirmedExpense.status, 200);
  assert.equal(confirmedExpense.json.result.kind, 'expense');
  assert.equal(confirmedExpense.json.result.expense.amount, 120);
  assert.equal(confirmedExpense.json.result.expense.category, 'Food');
});

test('expenses, budgets and summaries are scoped and aggregated', async () => {
  const created = await call('/expenses', {
    method: 'POST',
    body: JSON.stringify({ amount: 500, category: 'Groceries', note: 'Weekly vegetables' }),
  });
  assert.equal(created.status, 201);

  const summary = await call('/expenses/summary?period=month');
  assert.equal(summary.status, 200);
  assert.ok(summary.json.summary.expenses >= 620);
  assert.ok(summary.json.summary.byCategory.some((c: { category: string }) => c.category === 'Groceries'));

  const month = new Date().toISOString().slice(0, 7);
  const budget = await call('/expenses/budget', {
    method: 'PUT',
    body: JSON.stringify({ month, amount: 10_000 }),
  });
  assert.equal(budget.status, 200);
  assert.equal(budget.json.budget.amount, 10_000);

  const afterBudget = await call('/expenses/summary?period=month');
  assert.equal(afterBudget.json.summary.budget.amount, 10_000);
});

test('memories can be created, listed, updated and deleted', async () => {
  const created = await call('/memories', {
    method: 'POST',
    body: JSON.stringify({ kind: 'date', key: 'Birthday', value: 'May 12' }),
  });
  assert.equal(created.status, 201);
  const id = created.json.memory.id;

  const listed = await call('/memories?kind=date');
  assert.equal(listed.status, 200);
  assert.equal(listed.json.memories.length, 1);

  const all = await call('/memories');
  assert.equal(all.status, 200);
  assert.ok(all.json.memories.some((m: { id: string }) => m.id === id));

  const updated = await call(`/memories/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ value: 'May 13' }),
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.json.memory.value, 'May 13');

  const removed = await call(`/memories/${id}`, { method: 'DELETE' });
  assert.equal(removed.status, 204);
});

test('documents and services fail explicitly when not configured', async () => {
  const scan = await call('/documents/scan', { method: 'POST' });
  assert.equal(scan.status, 503);
  assert.equal(scan.json.error.code, 'NOT_CONFIGURED');

  const services = await call('/services?category=plumber&lat=13.08&lng=80.27');
  assert.equal(services.status, 503);
  assert.equal(services.json.error.code, 'NOT_CONFIGURED');
});

test('notification device registration and export work', async () => {
  const device = await call('/notifications/devices', {
    method: 'POST',
    body: JSON.stringify({ token: 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]', platform: 'android' }),
  });
  assert.equal(device.status, 201);

  const exported = await call('/account/export');
  assert.equal(exported.status, 200);
  assert.equal(exported.json.account.email, email);
  assert.ok(Array.isArray(exported.json.reminders));
  assert.ok(Array.isArray(exported.json.expenses));
});

test('rejects unauthenticated and cross-account access', async () => {
  const saved = accessToken;
  accessToken = '';
  const anonymous = await call('/reminders');
  assert.equal(anonymous.status, 401);
  accessToken = saved;

  const other = await call('/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      email: `other-${Date.now()}@example.com`,
      password,
      name: 'Other User',
      locale: 'en',
      timezone: 'Asia/Kolkata',
    }),
  });
  assert.equal(other.status, 201);
  const otherToken = other.json.accessToken;
  const ownReminders = (await call('/reminders')).json.reminders as Array<{ id: string }>;
  accessToken = otherToken;
  const foreign = await call(`/reminders/${ownReminders[0]!.id}`);
  assert.equal(foreign.status, 404);
  accessToken = saved;
});

test('refreshes tokens and deletes the account with a password', async () => {
  const saved = accessToken;
  accessToken = '';
  const refreshed = await call('/auth/refresh', {
    method: 'POST',
    body: JSON.stringify({ refreshToken }),
  });
  assert.equal(refreshed.status, 200);
  accessToken = refreshed.json.accessToken;
  assert.ok(accessToken);
  assert.ok(refreshed.json.refreshToken);

  const replay = await call('/auth/refresh', {
    method: 'POST',
    body: JSON.stringify({ refreshToken }),
  });
  assert.equal(replay.status, 401);

  const rejected = await call('/account', {
    method: 'DELETE',
    body: JSON.stringify({ password: 'wrong password' }),
  });
  assert.equal(rejected.status, 401);

  const deleted = await call('/account', {
    method: 'DELETE',
    body: JSON.stringify({ password }),
  });
  assert.equal(deleted.status, 204);
  accessToken = saved;
  assert.equal(refreshed.status, 200);
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await closeDb();
});
