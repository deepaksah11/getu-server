import path from 'path';
import { env } from './env.js';

/**
 * Every file the server writes lives under DATA_DIR so tests can point it at a
 * throwaway directory and never touch the real database or sessions.
 */
const dataDir = path.resolve(env.DATA_DIR || path.resolve(process.cwd(), 'data'));

export const paths = {
  dataDir,
  dbFile: path.join(dataDir, 'db.json'),
  resumesDir: path.join(dataDir, 'resumes'),
  screenshotsDir: path.join(dataDir, 'screenshots'),
  sessionsDir: path.join(dataDir, 'sessions'),
  vaultKeyFile: path.join(dataDir, '.vault-key'),
};
