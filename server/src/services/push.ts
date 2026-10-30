import { inArray } from 'drizzle-orm';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { devices } from '../db/schema.js';

export interface PushTicket {
  token: string;
  id?: string;
  error?: string;
}

interface ExpoTicketResponse {
  data?: Array<{
    status: 'ok' | 'error';
    id?: string;
    message?: string;
    details?: { error?: string };
  }>;
}

export async function sendPush(
  tokens: string[],
  message: { title: string; body: string; data?: Record<string, unknown>; tag?: string },
): Promise<{ tickets: PushTicket[]; invalidTokens: string[] }> {
  const unique = [...new Set(tokens.filter(Boolean))];
  if (unique.length === 0) return { tickets: [], invalidTokens: [] };

  const tickets: PushTicket[] = [];
  const invalidTokens: string[] = [];

  for (let i = 0; i < unique.length; i += 100) {
    const batch = unique.slice(i, i + 100);
    const res = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(config.EXPO_ACCESS_TOKEN
          ? { Authorization: `Bearer ${config.EXPO_ACCESS_TOKEN}` }
          : {}),
      },
      body: JSON.stringify(
        batch.map((to) => ({
          to,
          title: message.title,
          body: message.body,
          sound: 'default',
          channelId: 'reminders',
          tag: message.tag,
          collapseId: message.tag,
          data: message.data ?? {},
        })),
      ),
      signal: AbortSignal.timeout(20_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Expo push failed ${res.status}: ${text.slice(0, 200)}`);
    }

    const json = (await res.json()) as ExpoTicketResponse;
    (json.data ?? []).forEach((ticket, index) => {
      const token = batch[index];
      if (!token) return;
      if (ticket.status === 'ok') {
        tickets.push({ token, id: ticket.id });
      } else {
        tickets.push({ token, error: ticket.message ?? ticket.details?.error ?? 'error' });
        if (ticket.details?.error === 'DeviceNotRegistered') invalidTokens.push(token);
      }
    });
  }

  return { tickets, invalidTokens };
}

export async function removeInvalidTokens(tokens: string[]) {
  if (tokens.length === 0) return;
  await db.delete(devices).where(inArray(devices.expoPushToken, tokens));
}
