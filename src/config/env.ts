import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { z } from 'zod';

const rootEnv = path.resolve(process.cwd(), '.env');
const parentEnv = path.resolve(process.cwd(), '..', '.env');

if (fs.existsSync(rootEnv)) {
  dotenv.config({ path: rootEnv });
}
if (fs.existsSync(parentEnv)) {
  dotenv.config({ path: parentEnv });
}

/**
 * z.coerce.boolean() treats every non-empty string (including "false") as true,
 * so boolean env vars are parsed explicitly.
 */
const envBoolean = (defaultValue: boolean) =>
  z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => {
      if (v === undefined || v === '') return defaultValue;
      if (typeof v === 'boolean') return v;
      return ['true', '1', 'yes', 'on'].includes(v.trim().toLowerCase());
    });

const envSchema = z.object({
  PORT: z.coerce.number().default(5000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // Supabase (optional for standalone local mode, fully supported for production)
  SUPABASE_URL: z.string().optional(),
  SUPABASE_ANON_KEY: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),

  // Storage Adapter
  STORAGE_MODE: z.enum(['auto', 'supabase', 'file']).default('auto'),
  // Directory for the local database, generated resumes, screenshots and browser sessions
  DATA_DIR: z.string().optional(),
  // Seeds the demo job board (local mock portal jobs) into a fresh database
  SEED_DEMO_DATA: envBoolean(false),

  // AI
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default('gemini-2.5-flash'),

  // Automation settings
  AUTOMATION_ENABLED: envBoolean(false),
  AUTOMATION_MODE: z.enum(['dry-run', 'production']).default('dry-run'),
  MAX_APPLICATIONS_PER_DAY: z.coerce.number().default(25),
  // Pause between two applications in one run (politeness towards job platforms)
  APPLY_DELAY_MS: z.coerce.number().default(20000),
  // How often the scheduler checks whether a user's interval has elapsed
  SCHEDULER_TICK_MS: z.coerce.number().default(60000),

  // Playwright Browser
  BROWSER_HEADLESS: envBoolean(true),
  BROWSER_TIMEOUT: z.coerce.number().default(30000),
  // 'auto' prefers an installed Google Chrome / Edge, falling back to Playwright's Chromium
  BROWSER_CHANNEL: z.enum(['auto', 'chromium', 'chrome', 'msedge']).default('auto'),
  // Minutes to wait for the user to finish an interactive login (OTP / CAPTCHA) in the visible browser
  INTERACTIVE_LOGIN_TIMEOUT_MINS: z.coerce.number().default(5),

  // Encryption secret for stored platform passwords and sessions.
  // When unset, a random key is generated once and kept in DATA_DIR/.vault-key
  CREDENTIALS_SECRET: z.string().optional(),

  // Client URL for CORS
  CLIENT_URL: z.string().default('http://localhost:5173'),
});

export type Env = z.infer<typeof envSchema>;

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.format());
  throw new Error('Environment configuration error');
}

export const env = parsed.data;
