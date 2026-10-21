import fs from 'fs/promises';
import path from 'path';
import { paths } from '../../config/paths.js';
import { logger } from '../../config/logger.js';
import { vault } from './vault.js';

/** Playwright storage state (cookies + localStorage). */
export type StorageState = {
  cookies: any[];
  origins: any[];
};

function sessionFile(userId: string, platform: string): string {
  const safeUser = userId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const safePlatform = platform.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(paths.sessionsDir, safeUser, `${safePlatform}.session`);
}

/**
 * Browser sessions are what make "log in once" work: after the first login the
 * platform's cookies are kept (encrypted) and reused by every later run.
 */
export const sessionStore = {
  async load(userId: string, platform: string): Promise<StorageState | undefined> {
    try {
      const raw = await fs.readFile(sessionFile(userId, platform), 'utf-8');
      return JSON.parse(vault.decrypt(JSON.parse(raw))) as StorageState;
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        logger.warn({ platform, err: err.message }, 'Stored browser session unreadable; a fresh login will be needed');
      }
      return undefined;
    }
  },

  async save(userId: string, platform: string, state: StorageState): Promise<void> {
    const file = sessionFile(userId, platform);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(vault.encrypt(JSON.stringify(state))), { encoding: 'utf-8', mode: 0o600 });
    await fs.rename(tmp, file);
  },

  async has(userId: string, platform: string): Promise<boolean> {
    try {
      await fs.access(sessionFile(userId, platform));
      return true;
    } catch {
      return false;
    }
  },

  async remove(userId: string, platform: string): Promise<void> {
    await fs.rm(sessionFile(userId, platform), { force: true });
  },
};
