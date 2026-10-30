import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { db, type Database } from './index.js';

const migrationDir = join(process.cwd(), 'drizzle');

export async function migrate(database: Database = db) {
  await database.execute(
    sql`CREATE TABLE IF NOT EXISTS __migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
  );

  let files: string[] = [];
  try {
    files = (await readdir(migrationDir)).filter((f) => f.endsWith('.sql')).sort();
  } catch {
    throw new Error(`Migration directory not found: ${migrationDir}. Run npm run db:generate.`);
  }

  const applied = await database.execute<{ name: string }>(sql`SELECT name FROM __migrations`);
  const done = new Set((applied.rows as Array<{ name: string }>).map((r) => r.name));

  for (const file of files) {
    if (done.has(file)) continue;
    const contents = await readFile(join(migrationDir, file), 'utf8');
    const statements = contents
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean);

    for (const statement of statements) {
      await database.execute(sql.raw(statement));
    }
    await database.execute(sql`INSERT INTO __migrations (name) VALUES (${file})`);
    console.log(`Applied migration ${file}`);
  }
}
