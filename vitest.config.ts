import fs from 'fs';
import os from 'os';
import path from 'path';
import { defineConfig } from 'vitest/config';

// Every test run gets a throwaway data directory: the real database, resumes and
// platform sessions are never touched, and no real AI provider is called.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoapply-test-'));
const live = process.env.LIVE_TESTS === '1';

export default defineConfig({
  test: {
    environment: 'node',
    include: live ? ['src/test/live/**/*.test.ts'] : ['src/test/**/*.test.ts'],
    exclude: live ? [] : ['src/test/live/**'],
    testTimeout: 90000,
    hookTimeout: 90000,
    fileParallelism: false,
    globalSetup: ['./src/test/globalSetup.ts'],
    env: {
      NODE_ENV: 'test',
      PORT: '5099',
      DATA_DIR: dataDir,
      GEMINI_API_KEY: '',
      SEED_DEMO_DATA: 'true',
      // The string "false" must parse as false (it used to coerce to true)
      AUTOMATION_ENABLED: 'false',
      APPLY_DELAY_MS: '0',
      BROWSER_HEADLESS: 'true',
      BROWSER_CHANNEL: 'chromium',
      CREDENTIALS_SECRET: 'vitest-only-secret',
      SCHEDULER_TICK_MS: '3600000',
    },
  },
});
