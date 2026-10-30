import { config } from '../config.js';

export interface AiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AiToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface AiReply {
  content: string | null;
  toolCalls: AiToolCall[];
}

export const aiTools = [
  {
    type: 'function',
    function: {
      name: 'create_reminder',
      description:
        'Create a household reminder. The app asks the user to confirm before saving. Use only when the user asked for a reminder and a title is known.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short reminder title, e.g. Pay EB bill' },
          category: {
            type: 'string',
            enum: [
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
            ],
          },
          dueAt: {
            type: 'string',
            description: 'First occurrence as ISO 8601 with timezone offset, e.g. 2026-11-01T09:00:00+05:30',
          },
          recurrence: { type: 'string', enum: ['once', 'daily', 'weekly', 'monthly', 'yearly'] },
          advanceMinutes: {
            type: 'array',
            items: { type: 'integer' },
            description: 'Advance notice offsets in minutes, e.g. [1440] for one day before.',
          },
          notes: { type: 'string' },
          amount: { type: 'number', description: 'Bill amount in INR if stated.' },
        },
        required: ['title', 'dueAt', 'recurrence'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'log_expense',
      description:
        'Record an expense or income. The app asks the user to confirm before saving. Do not call without an explicit amount.',
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['expense', 'income'] },
          amount: { type: 'number', description: 'Amount in INR' },
          category: {
            type: 'string',
            enum: [
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
            ],
          },
          note: { type: 'string' },
          occurredAt: {
            type: 'string',
            description: 'ISO 8601 with timezone offset. Omit for now.',
          },
        },
        required: ['type', 'amount', 'category'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remember',
      description:
        'Save a personal fact the user explicitly asked to remember. The app asks for confirmation first. Never store inferred guesses.',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['date', 'preference', 'person', 'task', 'fact'] },
          key: { type: 'string' },
          value: { type: 'string' },
        },
        required: ['kind', 'key', 'value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_expenses',
      description: 'Read the spending total for a period. Use for questions like "how much did I spend this month".',
      parameters: {
        type: 'object',
        properties: { period: { type: 'string', enum: ['day', 'week', 'month'] } },
        required: ['period'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_reminders',
      description: 'Read upcoming reminders. Use when the user asks what reminders they have.',
      parameters: {
        type: 'object',
        properties: { scope: { type: 'string', enum: ['upcoming', 'all'] } },
        required: ['scope'],
      },
    },
  },
] as const;

function baseUrl() {
  return config.AI_BASE_URL.replace(/\/+$/, '');
}

async function chatCompletion(body: Record<string, unknown>) {
  if (!config.AI_API_KEY) throw new Error('AI_API_KEY is not configured');
  const res = await fetch(`${baseUrl()}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.AI_API_KEY}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`AI provider returned ${res.status}: ${text.slice(0, 300)}`);
  }
  const json = (await res.json()) as {
    choices?: Array<{
      message?: {
        content?: string | null;
        tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
      };
    }>;
  };
  return json.choices?.[0]?.message ?? {};
}

export async function chatWithTools(messages: AiMessage[]): Promise<AiReply> {
  const message = await chatCompletion({
    model: config.AI_MODEL,
    messages,
    tools: aiTools,
    tool_choice: 'auto',
    temperature: 0.2,
  });
  return {
    content: message.content ?? null,
    toolCalls: (message.tool_calls ?? []).map((call) => ({
      id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
    })),
  };
}

export async function chatText(messages: AiMessage[]): Promise<string> {
  const message = await chatCompletion({
    model: config.AI_MODEL,
    messages,
    temperature: 0.3,
    max_tokens: 220,
  });
  return (message.content ?? '').trim();
}

/** Ask a vision model for structured JSON and parse it defensively. */
export async function visionJson(
  imageDataUrl: string,
  prompt: string,
): Promise<Record<string, unknown>> {
  const message = await chatCompletion({
    model: config.AI_VISION_MODEL,
    temperature: 0,
    max_tokens: 1500,
    messages: [
      {
        role: 'system',
        content:
          'You extract data from document photos. Reply with a single JSON object and nothing else. Never guess: use null for fields you cannot read confidently.',
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: imageDataUrl } },
        ],
      },
    ],
  });
  const text = message.content ?? '';
  return parseJsonObject(text);
}

export function parseJsonObject(text: string): Record<string, unknown> {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('AI returned no JSON');
  const parsed: unknown = JSON.parse(cleaned.slice(start, end + 1));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('AI returned invalid JSON');
  }
  return parsed as Record<string, unknown>;
}

export function aiErrorSummary(error: unknown) {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'AI request timed out';
    return error.message.slice(0, 300);
  }
  return 'AI request failed';
}
