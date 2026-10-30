import type {
  ActionType,
  ExpensePayload,
  MemoryPayload,
  ReminderPayload,
} from '../lib/schemas.js';
import { formatDateTime } from '../lib/time.js';

export function formatMoney(amount: number, locale = 'en') {
  return new Intl.NumberFormat(locale === 'ta' ? 'ta-IN' : 'en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 2,
    minimumFractionDigits: 0,
  }).format(amount);
}

export function actionSummary(
  type: ActionType,
  payload: unknown,
  timezone: string,
  locale = 'en',
): string {
  const ta = locale === 'ta';
  if (type === 'create_reminder') {
    const p = payload as ReminderPayload;
    const repeat = p.recurrence === 'once' ? '' : ta ? ` · ${p.recurrence}` : ` · ${p.recurrence}`;
    return `${ta ? 'நினைவூட்டல்' : 'Reminder'}: ${p.title}\n${formatDateTime(p.dueAt, timezone, locale)}${repeat}`;
  }
  if (type === 'log_expense') {
    const p = payload as ExpensePayload;
    const when = p.occurredAt ?? new Date().toISOString();
    return `${ta ? (p.type === 'income' ? 'வருமானம்' : 'செலவு') : p.type === 'income' ? 'Income' : 'Expense'}: ${formatMoney(p.amount, locale)} · ${p.category}\n${formatDateTime(when, timezone, locale)}`;
  }
  if (type === 'remember') {
    const p = payload as MemoryPayload;
    return `${ta ? 'நினைவில் வை' : 'Remember'}: ${p.key} — ${p.value}`;
  }
  return '';
}

export function confirmationReply(
  type: ActionType,
  payload: unknown,
  timezone: string,
  locale = 'en',
) {
  const summary = actionSummary(type, payload, timezone, locale);
  const question =
    locale === 'ta' ? 'இதைச் சேமிக்கவா?' : 'Do you want me to save this?';
  return `${question}\n\n${summary}`;
}

export const strings = {
  saved: (locale: string) => (locale === 'ta' ? 'சேமிக்கப்பட்டது ✅' : 'Saved ✅'),
  cancelled: (locale: string) =>
    locale === 'ta' ? 'ரத்து செய்யப்பட்டது.' : 'Cancelled. Nothing was saved.',
  expired: (locale: string) =>
    locale === 'ta'
      ? 'இந்த உறுதிப்படுத்தல் காலாவதியானது. மீண்டும் சொல்லுங்கள்.'
      : 'That confirmation expired. Please ask me again.',
  missingAmount: (locale: string) =>
    locale === 'ta' ? 'எவ்வளவு செலவு? தொகையைச் சொல்லுங்கள்.' : 'How much was it? Tell me the amount.',
  missingTitle: (locale: string) =>
    locale === 'ta'
      ? 'எதற்கு நினைவூட்ட வேண்டும்? தலைப்பைச் சொல்லுங்கள்.'
      : 'What should I remind you about?',
  pastTime: (locale: string) =>
    locale === 'ta'
      ? 'அந்த நேரம் ஏற்கனவே கடந்துவிட்டது. வேறு நேரம் சொல்லுங்கள்.'
      : 'That time has already passed today. Please give a future time.',
  pastDate: (locale: string) =>
    locale === 'ta' ? 'அந்த தேதி கடந்துவிட்டது.' : 'That date is in the past.',
  genericError: (locale: string) =>
    locale === 'ta'
      ? 'மன்னிக்கவும், அதைப் புரிந்துகொள்ள முடியவில்லை. நினைவூட்டல், செலவு அல்லது ஆவணம் பற்றி கேளுங்கள்.'
      : 'Sorry, I could not process that. Try a reminder, an expense, or ask for a summary.',
  noUpcoming: (locale: string) =>
    locale === 'ta' ? 'வரவிருக்கும் நினைவூட்டல்கள் இல்லை.' : 'No upcoming reminders.',
  noExpenses: (locale: string) =>
    locale === 'ta' ? 'இந்த காலத்தில் செலவுகள் இல்லை.' : 'No expenses in this period.',
  confirmHint: (locale: string) =>
    locale === 'ta'
      ? 'சேமிக்க சரி என்பதைத் தட்டுங்கள்.'
      : 'Tap Confirm to save it.',
};

export function helpReply(locale: string) {
  if (locale === 'ta') {
    return [
      'வணக்கம்! நான் உங்கள் தனிப்பட்ட உதவியாளர்.',
      'நான் செய்யக்கூடியவை:',
      '• நினைவூட்டல்கள் — "நாளைக்கு காலை 9 மணிக்கு EB bill நினைவூட்டு"',
      '• செலவுகள் — "இன்னைக்கு பெட்ரோலுக்கு 250 ரூபாய் செலவு"',
      '• சுருக்கம் — "இந்த மாத செலவு எவ்வளவு?"',
      '• நினைவகம் — "என் பிறந்தநாள் மே 12 என்று நினைவில் வை"',
    ].join('\n');
  }
  return [
    'Hi! I am your personal assistant.',
    "I can handle:",
    '• Reminders — "Remind me to pay rent tomorrow at 9 AM"',
    '• Expenses — "Today I spent 250 rupees on petrol"',
    '• Summaries — "How much did I spend this month?"',
    '• Memory — "Remember my birthday is May 12"',
  ].join('\n');
}
