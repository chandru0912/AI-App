import { z } from 'zod';

try {
  process.loadEnvFile();
} catch {
  // .env is optional in CI; real environments provide variables directly.
}

const bool = (fallback: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => (v === undefined ? fallback : v === 'true' || v === '1'));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: z.string().min(1).optional(),
  PGLITE_DIR: z.string().default('.data/pglite'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  CORS_ORIGINS: z.string().default('http://localhost:8081,http://localhost:19006'),
  AUTO_MIGRATE: bool(true),
  SCHEDULER_ENABLED: bool(true),
  AI_API_KEY: z.string().optional(),
  AI_BASE_URL: z.string().default('https://api.openai.com/v1'),
  AI_MODEL: z.string().default('gpt-4o-mini'),
  AI_VISION_MODEL: z.string().default('gpt-4o-mini'),
  GOOGLE_PLACES_API_KEY: z.string().optional(),
  DOCUMENT_ENCRYPTION_KEY: z.string().optional(),
  EXPO_ACCESS_TOKEN: z.string().optional(),
  UPLOAD_DIR: z.string().default('uploads'),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const config = {
  ...parsed.data,
  corsOrigins: parsed.data.CORS_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  isProd: parsed.data.NODE_ENV === 'production',
  aiEnabled: Boolean(parsed.data.AI_API_KEY),
  placesEnabled: Boolean(parsed.data.GOOGLE_PLACES_API_KEY),
};

export type AppConfig = typeof config;
