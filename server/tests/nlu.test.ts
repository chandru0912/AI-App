import test from 'node:test';
import assert from 'node:assert/strict';
import { interpret, detectLanguage } from '../src/services/nlu.js';

const context = { timezone: 'Asia/Kolkata', now: new Date('2026-10-30T04:00:00Z') }; // 9:30 AM IST

test('detects Tamil script and Tanglish', () => {
  assert.equal(detectLanguage('நாளைக்கு EB bill கட்ட'), 'ta');
  assert.equal(detectLanguage('naalaiku EB bill pannu'), 'tanglish');
  assert.equal(detectLanguage('Remind me tomorrow'), 'en');
});

test('parses an English reminder with date, time, category and amount', () => {
  const result = interpret('Remind me to pay electricity bill tomorrow at 9 am for 450 rupees', context);
  assert.equal(result.intent, 'create_reminder');
  assert.equal(result.action?.type, 'create_reminder');
  if (result.action?.type !== 'create_reminder') return;
  assert.equal(result.action.payload.category, 'electricity');
  assert.equal(result.action.payload.amount, 450);
  assert.equal(result.action.payload.recurrence, 'once');
  assert.match(result.action.payload.title.toLowerCase(), /electricity bill/);
  assert.equal(result.action.payload.dueAt, '2026-10-31T03:30:00.000Z');
});

test('parses Tanglish recurring reminders with advance notice', () => {
  const result = interpret('naalaiku kaalai 9 mani rent pannunga 2 days before', context);
  assert.equal(result.action?.type, 'create_reminder');
  if (result.action?.type !== 'create_reminder') return;
  assert.equal(result.action.payload.category, 'rent');
  assert.deepEqual(result.action.payload.advanceMinutes, [2880]);
});

test('parses an expense with category and asks for a missing amount', () => {
  const expense = interpret('Today I spent 250 rupees on petrol', context);
  assert.equal(expense.action?.type, 'log_expense');
  if (expense.action?.type !== 'log_expense') return;
  assert.equal(expense.action.payload.amount, 250);
  assert.equal(expense.action.payload.category, 'Transportation');

  const missing = interpret('I spent some money on tea', context);
  assert.equal(missing.intent, 'clarify');
  assert.equal(missing.action, undefined);
});

test('parses spending queries and memory requests', () => {
  assert.equal(interpret('How much did I spend this month?', context).action?.type, 'query_expenses');
  const memory = interpret('Remember my birthday is May 12', context);
  assert.equal(memory.action?.type, 'remember');
  if (memory.action?.type !== 'remember') return;
  assert.equal(memory.action.payload.kind, 'date');
  assert.match(memory.action.payload.key, /birthday/i);
});

test('asks for a title when a reminder has no subject', () => {
  const result = interpret('remind me tomorrow at 9 am', context);
  assert.equal(result.intent, 'clarify');
  assert.equal(result.action, undefined);
});
