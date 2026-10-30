import { DateTime } from 'luxon';
import {
  EXPENSE_CATEGORIES,
  MEMORY_KINDS,
  normalizeAdvance,
  type ActionType,
  type ExpensePayload,
  type MemoryPayload,
  type ReminderPayload,
} from '../lib/schemas.js';
import { helpReply, strings } from './format.js';

export type Language = 'en' | 'ta' | 'tanglish';

export type NluAction =
  | { type: 'create_reminder'; payload: ReminderPayload }
  | { type: 'log_expense'; payload: ExpensePayload }
  | { type: 'remember'; payload: MemoryPayload }
  | { type: 'query_expenses'; payload: { period: 'day' | 'week' | 'month' } }
  | { type: 'list_reminders'; payload: { scope: 'upcoming' | 'all' } };

export interface NluResult {
  language: Language;
  reply: string;
  action?: NluAction;
  intent: ActionType | 'chat' | 'clarify' | 'help';
}

export interface NluContext {
  timezone: string;
  now?: Date;
}

const TAMIL = /[\u0B80-\u0BFF]/;
const ROMAN_TAMIL =
  /\b(naalaiku|naalai|innaiku|indhaiku|indru|pannu|pannunga|panniko|selavu|selavitthen|evlo|evvalavu|venum|vendum|mani|kaalai|maalai|iravu|rubaai|rubai|adutha|vaaram|maasam|varusham|nyabagam|vachiko|munnadi|enna|vanakkam|thaan|illai|aama|sari)\b/i;

export function detectLanguage(text: string): Language {
  if (TAMIL.test(text)) return 'ta';
  if (ROMAN_TAMIL.test(text)) return 'tanglish';
  return 'en';
}

const replyLocale = (language: Language) => (language === 'en' ? 'en' : 'ta');

const TIME_PATTERNS = [
  /\b\d{1,2}(?:[:.]\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)/gi,
  /\b\d{1,2}[:.]\d{2}\b/g,
  /\d{1,2}(?:\s*[:.]\s*\d{2})?\s*(?:mani|மணி|மணிக்கு)/gi,
  /\b\d{1,2}\s*o'?clock\b/gi,
  /(?:morning|kaalai|காலை|evening|maalai|மாலை|night|iravu|இரவு|afternoon|மதியம்)\s*(?:at\s*)?\d{1,2}(?::\d{2})?/gi,
  /\b\d{1,2}(?::\d{2})?\s*(?:in the\s*)?(?:morning|kaalai|காலை|evening|maalai|மாலை|night|iravu|இரவு|afternoon|மதியம்)\b/gi,
];

const DATE_PATTERNS = [
  /\b(?:today|tonight|tomorrow|yesterday|next week|next month|day after tomorrow)\b/gi,
  /\b(?:innaiku|indhaiku|naalaiku|naalai|naetru|adutha vaaram|adutha maasam)\b/gi,
  /(?:இன்று|இன்னிக்கு|நாளை|நாளைக்கு|நேற்று|அடுத்த வாரம்|அடுத்த மாதம்)/g,
  /\b(?:next\s+)?(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/gi,
  /(?:ஞாயிறு|திங்கள்|செவ்வாய்|புதன்|வியாழன்|வெள்ளி|சனி)/g,
  /\b\d{4}-\d{1,2}-\d{1,2}\b/g,
  /\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/g,
  /\b\d{1,2}(?:st|nd|rd|th)\b/gi,
  /\d{1,2}\s*(?:ஆம்)?\s*தேதி/g,
];

const RECURRENCE_PATTERNS = [
  /\b(?:every day|daily|every week|weekly|every month|monthly|every year|yearly|annually)\b/gi,
  /\b(?:every|each)\s+(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/gi,
  /\b(?:naalum|roz|vaaram|maasam|varusham)\b/gi,
  /(?:தினமும்|ஒவ்வொரு நாளும்|வாரமும்|மாதமும்|ஆண்டுதோறும்)/g,
];

const ADVANCE_PATTERNS = [
  /\b(?:\d+|one|two|three|a)\s*(?:day|days|hour|hours|week|weeks|naal|mani|vaaram)\s*(?:before|munnadi|in advance|advance)\b/gi,
  /(?:\d+)\s*(?:நாள்|மணி|வாரம்)\s*(?:முன்பு|முன்)/g,
];

const COMMAND_PATTERNS = [
  /\b(?:remind me to|remind me|remind|reminder|set a reminder|set reminder|please|kindly)\b/gi,
  /\b(?:pannu|pannunga|panniko|pannidhu|vaithuko|vachiko|nyabagam|venum|vendum)\b/gi,
  /(?:ஞாபகப்படுத்து|நினைவூட்டு|நினைவூட்டல்|வேண்டும்|பண்ணு|பண்ணுங்க)/g,
  /\b(?:i|we)\s+(?:have\s+)?(?:spent|spend|paid|pay)\b/gi,
  /\b(?:spent|spend|expense|expenses|selavu|selavitthen)\b/gi,
  /(?:செலவு|செலவிட்டேன்|செலுத்தினேன்)/g,
];

function scrub(text: string, patterns: RegExp[]) {
  let out = text;
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, ' ');
  }
  return out.replace(/\s+/g, ' ').replace(/^[\s,.;:-]+|[\s,.;:-]+$/g, '').trim();
}

function parseAmountText(raw: string) {
  return Number(raw.replace(/,/g, ''));
}

function extractAmount(text: string, allowBare: boolean): number | null {
  const currency = text.match(
    /(?:₹|rs\.?|inr)\s*([\d,]+(?:\.\d{1,2})?)|([\d,]+(?:\.\d{1,2})?)\s*(?:rupees?|rubaai|rubai|ரூபாய்|rs\b|inr\b)/i,
  );
  if (currency) {
    const value = parseAmountText(currency[1] ?? currency[2] ?? '');
    if (Number.isFinite(value) && value > 0) return value;
  }
  if (!allowBare) return null;

  let cleaned = text;
  for (const pattern of TIME_PATTERNS) {
    pattern.lastIndex = 0;
    cleaned = cleaned.replace(pattern, ' ');
  }
  cleaned = cleaned
    .replace(/\b\d{4}-\d{1,2}-\d{1,2}\b/g, ' ')
    .replace(/\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/g, ' ')
    .replace(/\b\d{1,2}(?:st|nd|rd|th)\b/gi, ' ')
    .replace(/\b(?:19|20)\d{2}\b/g, ' ')
    .replace(/\b\d+\s*(?:days?|hours?|minutes?|naal|mani)\s*(?:before|munnadi|முன்)/gi, ' ');

  for (const match of cleaned.matchAll(/(?<![\d.])(\d{1,7}(?:,\d{3})*(?:\.\d{1,2})?)(?![\d])/g)) {
    const value = parseAmountText(match[1] ?? '');
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

interface ParsedTime {
  hour: number;
  minute: number;
}

function extractTime(text: string): ParsedTime | null {
  const candidates: Array<{ raw: RegExpMatchArray; kind: 'ampm' | 'hm' | 'mani' | 'period' }> = [];

  const ampm = text.match(/\b(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)/i);
  if (ampm) candidates.push({ raw: ampm, kind: 'ampm' });

  const hm = text.match(/\b(\d{1,2})[:.](\d{2})\b/);
  if (hm) candidates.push({ raw: hm, kind: 'hm' });

  const mani = text.match(/(\d{1,2})(?:\s*[:.]\s*(\d{2}))?\s*(?:mani|மணி|மணிக்கு)/i);
  if (mani) candidates.push({ raw: mani, kind: 'mani' });

  const clock = text.match(/\b(\d{1,2})\s*o'?clock\b/i);
  if (clock) candidates.push({ raw: clock, kind: 'hm' });

  const periodFirst = text.match(
    /(?:morning|kaalai|காலை|evening|maalai|மாலை|night|iravu|இரவு|afternoon|மதியம்)\s*(?:at\s*)?(\d{1,2})(?::(\d{2}))?/i,
  );
  if (periodFirst) candidates.push({ raw: periodFirst, kind: 'period' });

  const numPeriod = text.match(
    /\b(\d{1,2})(?::(\d{2}))?\s*(?:in the\s*)?(?:morning|kaalai|காலை|evening|maalai|மாலை|night|iravu|இரவு|afternoon|மதியம்)\b/i,
  );
  if (numPeriod) candidates.push({ raw: numPeriod, kind: 'period' });

  const first = candidates.sort((a, b) => (a.raw.index ?? 0) - (b.raw.index ?? 0))[0];
  if (!first) return null;

  let hour = Number(first.raw[1]);
  const minute = Number(first.raw[2] ?? 0);
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour > 23 || minute > 59) return null;

  if (first.kind === 'ampm') {
    const marker = (first.raw[3] ?? '').toLowerCase().replace(/\./g, '');
    if (marker === 'pm' && hour < 12) hour += 12;
    if (marker === 'am' && hour === 12) hour = 0;
    return { hour, minute };
  }

  const period = text.match(
    /(morning|kaalai|காலை|evening|maalai|மாலை|night|iravu|இரவு|afternoon|மதியம்)/i,
  )?.[1];
  if (period) {
    const p = period.toLowerCase();
    const evening = /evening|maalai|மாலை|night|iravu|இரவு|afternoon|மதியம்/.test(p);
    if (evening && hour < 12) hour += 12;
    if (/morning|kaalai|காலை/.test(p) && hour === 12) hour = 0;
  }
  return { hour, minute };
}

const WEEKDAYS: Record<string, number> = {
  sunday: 7,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
  ஞாயிறு: 7,
  திங்கள்: 1,
  செவ்வாய்: 2,
  புதன்: 3,
  வியாழன்: 4,
  வெள்ளி: 5,
  சனி: 6,
};

const WEEKDAY_PATTERN =
  /(?:\bnext\s+)?\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b|(ஞாயிறு|திங்கள்|செவ்வாய்|புதன்|வியாழன்|வெள்ளி|சனி)/i;

interface ParsedDate {
  date: DateTime;
  explicit: boolean;
  kind: 'today' | 'tomorrow' | 'future' | 'past' | 'none';
  weekdayTarget: number | null;
}

function parseDate(text: string, now: DateTime): ParsedDate | null {
  const base = now.startOf('day');
  let date: DateTime | null = null;
  let explicit = false;
  let kind: ParsedDate['kind'] = 'none';
  let weekdayTarget: number | null = null;

  const iso = text.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) {
    date = DateTime.fromObject(
      { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) },
      { zone: now.zone },
    );
    explicit = true;
    kind = date < base ? 'past' : 'future';
  }

  if (!date) {
    const dmy = text.match(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/);
    if (dmy) {
      let year = dmy[3] ? Number(dmy[3]) : now.year;
      if (year < 100) year += 2000;
      date = DateTime.fromObject(
        { year, month: Number(dmy[2]), day: Number(dmy[1]) },
        { zone: now.zone },
      );
      if (!dmy[3] && date < base) date = date.plus({ years: 1 });
      explicit = true;
      kind = date < base ? 'past' : date.hasSame(base, 'day') ? 'today' : 'future';
    }
  }

  if (!date && /\bday after tomorrow\b/i.test(text)) {
    date = base.plus({ days: 2 });
    explicit = true;
    kind = 'future';
  }

  if (!date && /\bnext month\b|\badutha maasam\b|அடுத்த மாதம்/i.test(text)) {
    date = base.plus({ months: 1 });
    explicit = true;
    kind = 'future';
  }

  if (!date && /\bnext week\b|\badutha vaaram\b|அடுத்த வாரம்/i.test(text)) {
    date = base.plus({ weeks: 1 });
    explicit = true;
    kind = 'future';
  }

  if (!date && /\btomorrow\b|\bnaalaiku\b|\bnaalai\b|நாளை|நாளைக்கு/i.test(text)) {
    date = base.plus({ days: 1 });
    explicit = true;
    kind = 'tomorrow';
  }

  if (!date && /\btoday\b|\btonight\b|\binnaiku\b|\bindhaiku\b|இன்று|இன்னிக்கு/i.test(text)) {
    date = base;
    explicit = true;
    kind = 'today';
  }

  if (!date && /\byesterday\b|\bnaetru\b|நேற்று/i.test(text)) {
    date = base.minus({ days: 1 });
    explicit = true;
    kind = 'past';
  }

  if (!date) {
    const weekday = text.match(WEEKDAY_PATTERN);
    if (weekday) {
      const name = (weekday[1] ?? weekday[2] ?? '').toLowerCase();
      const target = WEEKDAYS[name];
      if (target) {
        let diff = (target - now.weekday + 7) % 7;
        if (diff === 0) diff = 0;
        date = base.plus({ days: diff });
        weekdayTarget = target;
        explicit = true;
        kind = diff === 0 ? 'today' : 'future';
      }
    }
  }

  if (!date) {
    const nth = text.match(/\b(\d{1,2})(?:st|nd|rd|th)\b|(\d{1,2})\s*(?:ஆம்)?\s*தேதி/i);
    if (nth) {
      const day = Number(nth[1] ?? nth[2]);
      if (day >= 1 && day <= 31) {
        date = base.set({ day });
        if (date.day !== day) date = date.plus({ months: 1 }).set({ day });
        if (date < base) date = date.plus({ months: 1 });
        explicit = true;
        kind = date.hasSame(base, 'day') ? 'today' : 'future';
      }
    }
  }

  if (!date) return null;
  if (!date.isValid) return null;
  return { date, explicit, kind, weekdayTarget };
}

function detectRecurrence(text: string): ReminderPayload['recurrence'] {
  if (/\b(?:every day|daily|naalum|roz)\b|தினமும்|ஒவ்வொரு நாளும்/i.test(text)) return 'daily';
  if (
    /\b(?:every week|weekly|vaaram)\b|வாரமும்/i.test(text) ||
    /\b(?:every|each)\s+(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i.test(text)
  )
    return 'weekly';
  if (/\b(?:every month|monthly|maasam)\b|மாதமும்/i.test(text)) return 'monthly';
  if (/\b(?:every year|yearly|annually|varusham)\b|ஆண்டுதோறும்/i.test(text)) return 'yearly';
  return 'once';
}

function detectAdvance(text: string): number[] {
  const out: number[] = [];
  const wordNumbers: Record<string, number> = { a: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };
  const regex =
    /\b(\d+|one|two|three|four|five|six|seven|a)\s*(day|days|hour|hours|week|weeks|naal|mani|vaaram)\s*(?:before|munnadi|in advance|advance)\b/gi;
  for (const match of text.matchAll(regex)) {
    const n = Number(match[1]) || wordNumbers[(match[1] ?? '').toLowerCase()] || 0;
    const unit = (match[2] ?? '').toLowerCase();
    const minutes = unit.startsWith('day') || unit === 'naal' ? 1440 : unit.startsWith('hour') || unit === 'mani' ? 60 : 10080;
    if (n > 0 && n * minutes <= 10080) out.push(n * minutes);
  }
  return normalizeAdvance(out);
}

const REMINDER_CATEGORY_RULES: Array<[ReminderPayload['category'], RegExp]> = [
  ['vehicle_insurance', /\b(?:vehicle|car|bike)\s+insurance\b/i],
  ['vehicle_service', /\b(?:car|bike|vehicle)\s+service|servicing\b|சர்வீஸ்/i],
  ['electricity', /\b(?:electricity|electric|eb)\b|மின்(?:சார்ந்த)?|மின்சாரம்/i],
  ['water', /\bwater\b|தண்ணீர்/i],
  ['rent', /\brent\b|வாடகை/i],
  ['loan_emi', /\b(?:emi|loan)\b|கடன்/i],
  ['school_fees', /\bschool\s*fees?\b|\btuition\s*fees?\b|பள்ளி கட்டணம்/i],
  ['insurance', /\b(?:insurance|policy)\b|காப்பீடு/i],
  ['subscription', /\b(?:subscription|netflix|prime|hotstar|spotify|recharge)\b/i],
  ['warranty', /\bwarranty\b|உத்தரவாதம்/i],
];

function reminderCategory(text: string): ReminderPayload['category'] {
  for (const [category, pattern] of REMINDER_CATEGORY_RULES) {
    if (pattern.test(text)) return category;
  }
  return 'custom';
}

const EXPENSE_CATEGORY_RULES: Array<[ExpensePayload['category'], RegExp]> = [
  ['Transportation', /\b(?:petrol|diesel|fuel|bus|train|auto|uber|ola|cab|parking|toll)\b|பெட்ரோல்/i],
  ['Groceries', /\b(?:grocery|groceries|supermarket|provisions?|vegetables?)\b|மளிகை|காய்கறி/i],
  ['Food', /\b(?:food|restaurant|hotel|tea|coffee|snacks?|breakfast|lunch|dinner)\b|சாப்பாடு|உணவு/i],
  ['Utilities', /\b(?:electricity|electric|eb bill|water bill|gas|internet|broadband|phone bill)\b|மின்|தண்ணீர்/i],
  ['Housing', /\b(?:rent|maintenance)\b|வாடகை/i],
  ['Health', /\b(?:medicine|doctor|hospital|medical|pharmacy)\b|மருத்துவம்|மருந்து/i],
  ['Education', /\b(?:school|college|fees|tuition|books)\b|கல்வி|பள்ளி/i],
  ['Subscriptions', /\b(?:netflix|prime|hotstar|spotify|subscription)\b/i],
  ['Shopping', /\b(?:shopping|clothes|dress|amazon|flipkart|shirt|saree)\b/i],
  ['Entertainment', /\b(?:movie|cinema|game|concert)\b/i],
];

function expenseCategory(text: string, type: ExpensePayload['type']): ExpensePayload['category'] {
  if (type === 'income') return 'Income';
  for (const [category, pattern] of EXPENSE_CATEGORY_RULES) {
    if (pattern.test(text)) return category;
  }
  return 'Other';
}

function cleanTitle(text: string) {
  let title = scrub(text, [
    ...COMMAND_PATTERNS,
    ...DATE_PATTERNS,
    ...TIME_PATTERNS,
    ...RECURRENCE_PATTERNS,
    ...ADVANCE_PATTERNS,
    /\b(?:at|by|on|for|to)\b/gi,
    /\b(?:in the|the)\b/gi,
    /(?:என்று|என|ஆம்|தேதி)/g,
  ]);
  title = title.replace(/\s+/g, ' ').trim();
  title = title.replace(/^(?:to|that|for|on|at)\s+/i, '').trim();
  if (!title || /^(?:me|please)$/i.test(title)) return '';
  return title.charAt(0).toUpperCase() + title.slice(1);
}

function cleanExpenseNote(text: string) {
  let note = scrub(text, [
    ...COMMAND_PATTERNS,
    ...DATE_PATTERNS,
    ...TIME_PATTERNS,
    ...ADVANCE_PATTERNS,
    /(?:₹|rs\.?|inr)\s*[\d,]+(?:\.\d{1,2})?/gi,
    /[\d,]+(?:\.\d{1,2})?\s*(?:rupees?|rubaai|rubai|ரூபாய்|rs\b|inr\b)/gi,
    /\b(?:for|on|of|to)\b/gi,
    /(?:ரூபாய்|ரூபா)/g,
  ]);
  note = note.replace(/[\d,]+(?:\.\d{1,2})?/g, ' ').replace(/\s+/g, ' ').trim();
  return note.length >= 2 ? note : '';
}

function periodFromText(text: string): 'day' | 'week' | 'month' {
  if (/\b(?:today|tonight|innaiku|indhaiku)\b|இன்று|இன்னிக்கு/i.test(text)) return 'day';
  if (/\b(?:this week|week|vaaram)\b|இந்த வாரம்/i.test(text)) return 'week';
  return 'month';
}

function baseResult(language: Language, result: Omit<NluResult, 'language'>): NluResult {
  return { language, ...result };
}

export function interpret(text: string, context: NluContext): NluResult {
  const raw = text.trim();
  const language = detectLanguage(raw);
  const locale = replyLocale(language);
  const now = DateTime.fromJSDate(context.now ?? new Date(), { zone: context.timezone });
  const lower = raw.toLowerCase();

  if (!raw) return baseResult(language, { intent: 'help', reply: helpReply(locale) });

  if (/^(hi|hello|hey|vanakkam|வணக்கம்|help|உதவி)\b/i.test(raw) || raw.length < 3) {
    return baseResult(language, { intent: 'help', reply: helpReply(locale) });
  }

  const isQuery =
    /(?:how much|total|summary|report|evlo|evvalavu|எவ்வளவு)/i.test(raw) &&
    /(?:spen[dt]|expense|selavu|செலவு|budget|பட்ஜெட்)/i.test(raw);
  if (isQuery) {
    return baseResult(language, {
      intent: 'query_expenses',
      reply: '',
      action: { type: 'query_expenses', payload: { period: periodFromText(raw) } },
    });
  }

  if (
    /(?:reminders?|நினைவூட்டல்கள்)/i.test(raw) &&
    /(?:list|show|what|which|enna|என்ன|எத்தனை)/i.test(raw)
  ) {
    return baseResult(language, {
      intent: 'list_reminders',
      reply: '',
      action: { type: 'list_reminders', payload: { scope: 'upcoming' } },
    });
  }

  if (/(?:remember|note down|nyabagam vachiko|ஞாபகம் வைத்துக்கொள்)/i.test(raw)) {
    const rest = raw
      .replace(/^.*?(?:remember(?: that)?|note down|nyabagam vachiko|ஞாபகம் வைத்துக்கொள்)\s*/i, '')
      .trim();
    if (!rest) {
      return baseResult(language, {
        intent: 'clarify',
        reply: locale === 'ta' ? 'என்ன நினைவில் வைக்க வேண்டும்?' : 'What should I remember?',
      });
    }
    const split = rest.split(/\s+(?:is|as|equals|=|என்று)\s+/i);
    let key = (split[0] ?? rest).replace(/^(?:my|en|என்)\s+/i, '').trim();
    const value = split.length > 1 ? split.slice(1).join(' ').trim() : rest;
    if (!key) key = 'note';
    const kind = /birthday|anniversary|பிறந்தநாள்|திருமண நாள்/i.test(key)
      ? 'date'
      : /prefer|favourite|favorite|விருப்பம்/i.test(key)
        ? 'preference'
        : 'fact';
    const payload: MemoryPayload = {
      kind: MEMORY_KINDS.includes(kind as (typeof MEMORY_KINDS)[number])
        ? (kind as MemoryPayload['kind'])
        : 'fact',
      key: key.slice(0, 120),
      value: (value || rest).slice(0, 1000),
    };
    return baseResult(language, {
      intent: 'remember',
      reply: '',
      action: { type: 'remember', payload },
    });
  }

  const isReminder =
    /(?:remind|reminder|nyabagam|நினைவூட்ட|ஞாபகப்படுத்த)/i.test(raw) ||
    /(?:^|\s)pannu(?:nga)?\b/i.test(raw) && /(?:bill|rent|service|fees|emi|insurance|renewal)/i.test(raw);

  if (isReminder) {
    const parsedDate = parseDate(raw, now);
    const time = extractTime(raw);
    const recurrence = detectRecurrence(raw);
    const advanceMinutes = detectAdvance(raw);
    const title = cleanTitle(raw);

    if (!title) {
      return baseResult(language, { intent: 'clarify', reply: strings.missingTitle(locale) });
    }

    let date = parsedDate?.date ?? now.startOf('day');
    let due = date.set({
      hour: time?.hour ?? 9,
      minute: time?.minute ?? 0,
      second: 0,
      millisecond: 0,
    });

    if (parsedDate?.weekdayTarget && due <= now) {
      due = due.plus({ weeks: 1 });
    } else if (due <= now) {
      if (!parsedDate) {
        due = due.plus({ days: 1 });
      } else if (parsedDate.kind === 'past') {
        return baseResult(language, { intent: 'clarify', reply: strings.pastDate(locale) });
      } else if (parsedDate.explicit && !time && parsedDate.kind === 'today') {
        // A reminder with no explicit time defaults to 9 AM; if that already passed, use tomorrow.
        due = due.plus({ days: 1 });
      } else if (parsedDate.explicit && time && recurrence === 'once') {
        return baseResult(language, { intent: 'clarify', reply: strings.pastTime(locale) });
      } else if (recurrence === 'once') {
        due = due.plus({ days: 1 });
      }
    }

    const payload: ReminderPayload = {
      title,
      category: reminderCategory(raw),
      dueAt: due.toUTC().toISO() ?? new Date().toISOString(),
      recurrence,
      advanceMinutes,
    };
    const amount = extractAmount(raw, false);
    if (amount) payload.amount = amount;

    return baseResult(language, {
      intent: 'create_reminder',
      reply: '',
      action: { type: 'create_reminder', payload },
    });
  }

  const isExpense =
    /(?:spen[dt]|spend|expense|selavu|selavitthen|செலவு|paid|payment)/i.test(raw) &&
    !/(?:remind|reminder|நினைவூட்ட)/i.test(raw);

  if (isExpense) {
    const amount = extractAmount(raw, true);
    if (!amount) {
      return baseResult(language, { intent: 'clarify', reply: strings.missingAmount(locale) });
    }
    const type: ExpensePayload['type'] =
      /(?:income|salary|received|credited|சம்பளம்|வருமானம்)/i.test(raw) &&
      !/(?:spen[dt]|expense|selavu|செலவு)/i.test(raw)
        ? 'income'
        : 'expense';

    const parsedDate = parseDate(raw, now);
    let occurredAt: string;
    if (parsedDate && parsedDate.kind !== 'none') {
      occurredAt = parsedDate.date.set({ hour: 12, minute: 0 }).toUTC().toISO()!;
    } else {
      occurredAt = now.toUTC().toISO()!;
    }

    const payload: ExpensePayload = {
      type,
      amount,
      category: expenseCategory(raw, type),
      occurredAt,
    };
    const note = cleanExpenseNote(raw);
    if (note) payload.note = note;

    return baseResult(language, {
      intent: 'log_expense',
      reply: '',
      action: { type: 'log_expense', payload },
    });
  }

  return baseResult(language, { intent: 'chat', reply: helpReply(locale) });
}
