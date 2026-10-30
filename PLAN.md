# My Life AI — Build Plan

Personal AI agent for Tamil / English / Tanglish households: reminders, expenses, document
scanning, local services, memory, and proactive notifications.

## Architecture

```
mobile/  Expo SDK 58 + React Native 0.88 + TypeScript + Expo Router
   |  HTTPS + bearer token (SecureStore)
server/  Node 22+ + Express 5 + Drizzle ORM + PostgreSQL
   |  Drizzle (postgres.js in prod, embedded PGlite for zero-setup dev)
PostgreSQL
```

- **AI provider abstraction** (`server/src/services/ai.ts`): any OpenAI-compatible chat/vision
  endpoint. When `AI_API_KEY` is absent, a deterministic Tamil/Tanglish/English command parser
  still handles the core actions, so reminders and expenses work without a paid key.
- **AI tools** run through a confirmation gate. Write actions (`create_reminder`, `log_expense`,
  `remember`) are stored as `pending_actions` and only execute after the user confirms. Read
  actions (`query_expenses`, `list_reminders`) run immediately.
- **Reminders**: persisted in Postgres, mirrored to device local notifications (primary, works
  offline), plus an Expo push worker on the server that catches up after downtime and dedupes by
  occurrence + advance offset. RRULE recurrence with IANA timezones.
- **Documents**: private encrypted files (AES-256-GCM) in `server/uploads`, served only through
  authenticated endpoints. OCR returns editable fields and a suggested reminder; nothing is saved
  until the user confirms.
- **Local services**: Google Places API. No seed/fake listings. Without a key the endpoint
  returns `503 SERVICES_NOT_CONFIGURED`.
- **Auth**: bcrypt passwords, short-lived JWT access tokens, opaque hashed refresh sessions,
  per-user scoping on every query, rate limits, helmet, CORS allowlist.
- **Data control**: JSON export and password-confirmed account deletion (DB rows + encrypted files).

## Phases

1. **Foundation** — monorepo, Postgres schema/migrations, auth, app shell, themes, onboarding.
2. **Assistant** — chat + tool calling, deterministic NLU fallback, Tamil/Tanglish voice screen.
3. **Reminders** — CRUD, recurrence, local notifications, push worker, snooze/complete/history.
4. **Expenses** — CRUD, categories, budgets, summaries, charts, AI insight.
5. **Documents** — camera/upload, OCR, extraction review, confirm-then-save, encrypted storage.
6. **Local services** — Places search, category filters, ratings, reports.
7. **Memory + proactive** — confirmed facts, notification center, settings, data export/delete.
8. **Hardening** — validation, tests, docs, deployment notes.

## Required credentials (features degrade explicitly, never silently)

| Integration | Env | Without it |
| --- | --- | --- |
| LLM + OCR | `AI_API_KEY` (+ optional `AI_BASE_URL`, `AI_MODEL`, `AI_VISION_MODEL`) | rule-based assistant only; scanning returns 503 |
| Local services | `GOOGLE_PLACES_API_KEY` | services screen shows setup state |
| Push tokens | EAS project ID in `mobile/app.json` | local notifications still work |
| Document storage | `DOCUMENT_ENCRYPTION_KEY` | scanning returns 503 |
| Production DB | `DATABASE_URL` | embedded PGlite dev database |

## Known platform limits (documented, not hidden)

- Background AI voice playback is not promised; OS notification sounds and TTS on open only.
- Expo push is best-effort, not exact-time. Device local notifications are the primary path.
- iOS/Android may batch notifications; no app can guarantee exact delivery.
- Platform speech-to-text needs a development build (`expo-speech-recognition` is not in Expo Go).
- Google Places returns ratings/review counts and a Maps link; full review text is not mirrored.
- Email verification / password reset need an email provider and are not included.
