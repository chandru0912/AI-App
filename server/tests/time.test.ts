import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRrule, nextOccurrence, periodRange, upcomingOccurrences } from '../src/lib/time.js';

const start = new Date('2026-11-01T03:30:00Z'); // 9:00 AM IST

test('builds RRULEs preserving the local day and time', () => {
  assert.equal(buildRrule('once', start, 'Asia/Kolkata'), null);
  assert.equal(buildRrule('daily', start, 'Asia/Kolkata'), 'FREQ=DAILY');
  assert.equal(buildRrule('weekly', start, 'Asia/Kolkata'), 'FREQ=WEEKLY;BYDAY=SU');
  assert.equal(buildRrule('monthly', start, 'Asia/Kolkata'), 'FREQ=MONTHLY;BYMONTHDAY=1');
  assert.equal(buildRrule('yearly', start, 'Asia/Kolkata'), 'FREQ=YEARLY;BYMONTH=11;BYMONTHDAY=1');
});

test('advances to the next future occurrence', () => {
  const next = nextOccurrence('FREQ=MONTHLY;BYMONTHDAY=1', start, 'Asia/Kolkata', new Date('2026-12-15T00:00:00Z'));
  assert.equal(next?.toISOString(), '2027-01-01T03:30:00.000Z');
});

test('lists upcoming occurrences without duplicating the current one', () => {
  const list = upcomingOccurrences('FREQ=WEEKLY;BYDAY=SU', start, start, 'Asia/Kolkata', 3);
  assert.deepEqual(
    list.map((d) => d.toISOString()),
    ['2026-11-01T03:30:00.000Z', '2026-11-08T03:30:00.000Z', '2026-11-15T03:30:00.000Z'],
  );
});

test('month period range respects the user timezone', () => {
  const range = periodRange('month', 'Asia/Kolkata', new Date('2026-10-30T04:00:00Z'));
  assert.equal(range.month, '2026-10');
  assert.equal(range.from.toISOString(), '2026-09-30T18:30:00.000Z');
  assert.equal(range.to.toISOString(), '2026-10-31T18:30:00.000Z');
});
