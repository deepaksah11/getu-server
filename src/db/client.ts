import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { IRepository } from './repository.js';
import { FileStoreAdapter } from './fileStoreAdapter.js';
import { SupabaseAdapter } from './supabaseAdapter.js';

let repositoryInstance: IRepository;

export function getRepository(): IRepository {
  if (repositoryInstance) {
    return repositoryInstance;
  }

  const hasSupabase = Boolean(
    env.SUPABASE_URL && (env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY)
  );

  if (env.STORAGE_MODE === 'supabase' || (env.STORAGE_MODE === 'auto' && hasSupabase)) {
    try {
      logger.info('Connecting to Supabase PostgreSQL database');
      const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY!;
      repositoryInstance = new SupabaseAdapter(env.SUPABASE_URL!, key);
      return repositoryInstance;
    } catch (err) {
      logger.warn({ err }, 'Failed initializing Supabase, falling back to local FileStore adapter');
    }
  }

  logger.info('Using local FileStore adapter for persistence');
  repositoryInstance = new FileStoreAdapter();
  return repositoryInstance;
}

export const repository = getRepository();
