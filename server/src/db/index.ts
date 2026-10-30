import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import postgres from 'postgres';
import { config } from '../config.js';
import { schema } from './schema.js';

// Both drivers expose the same query-builder surface; only the result HKT differs.
// Queries are written against the shared PgDatabase API.
export type Database = PgDatabase<any, typeof schema>;

export let db: Database;
let closeFn: () => Promise<void> = async () => {};

if (config.DATABASE_URL) {
  const client = postgres(config.DATABASE_URL, { max: 10 });
  db = drizzlePostgres(client, { schema }) as unknown as Database;
  closeFn = () => client.end();
} else {
  if (config.isProd) {
    throw new Error('DATABASE_URL is required in production');
  }
  // PGlite creates its leaf directory but not the parent, so `npm run dev` failed on a fresh clone.
  if (config.PGLITE_DIR !== 'memory://') {
    mkdirSync(dirname(config.PGLITE_DIR), { recursive: true });
  }
  const pglite = new PGlite(config.PGLITE_DIR);
  db = drizzlePglite(pglite, { schema }) as unknown as Database;
  closeFn = () => pglite.close();
}

export const closeDb = () => closeFn();
