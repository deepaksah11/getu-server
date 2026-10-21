import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { IRepository } from './repository.js';
import { FileStoreAdapter } from './fileStoreAdapter.js';
import { SupabaseAdapter } from './supabaseAdapter.js';

let repositoryInstance: IRepository;

export function setRepository(repo: IRepository): void {
  repositoryInstance = repo;
}

export function createResilientRepository(primary: IRepository, fallback: FileStoreAdapter): IRepository {
  let active: IRepository = primary;
  let fallbackInitPromise: Promise<void> | null = null;

  const ensureFallbackInit = async () => {
    if (!fallbackInitPromise) {
      fallbackInitPromise = fallback.init();
    }
    await fallbackInitPromise;
  };

  return new Proxy(primary, {
    get(_target, prop, _receiver) {
      const orig = (active as any)[prop];
      if (typeof orig !== 'function') {
        return orig;
      }

      return async (...args: any[]) => {
        try {
          return await (active as any)[prop](...args);
        } catch (err: any) {
          if (active !== fallback) {
            logger.warn(
              { method: String(prop), err: err?.message || err },
              'Supabase operation failed; seamlessly failing over to local FileStore adapter'
            );
            await ensureFallbackInit();
            active = fallback;
            repositoryInstance = fallback;
            return await (fallback as any)[prop](...args);
          }
          throw err;
        }
      };
    },
  });
}

export function getRepository(): IRepository {
  if (repositoryInstance) {
    return repositoryInstance;
  }

  const hasSupabase = Boolean(
    env.SUPABASE_URL && (env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY)
  );

  if (env.STORAGE_MODE === 'file') {
    logger.info('Using local FileStore adapter for persistence (STORAGE_MODE=file)');
    repositoryInstance = new FileStoreAdapter();
    return repositoryInstance;
  }

  if (env.STORAGE_MODE === 'supabase' && hasSupabase) {
    try {
      logger.info('Connecting to Supabase PostgreSQL database (STORAGE_MODE=supabase)');
      const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY!;
      repositoryInstance = new SupabaseAdapter(env.SUPABASE_URL!, key);
      return repositoryInstance;
    } catch (err: any) {
      logger.error({ err: err?.message || err }, 'Failed initializing Supabase client');
      throw err;
    }
  }

  if (env.STORAGE_MODE === 'auto' && hasSupabase) {
    try {
      logger.info('Connecting to Supabase PostgreSQL database with resilient local fallback (STORAGE_MODE=auto)');
      const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY!;
      const primary = new SupabaseAdapter(env.SUPABASE_URL!, key);
      const fallback = new FileStoreAdapter();
      repositoryInstance = createResilientRepository(primary, fallback);
      return repositoryInstance;
    } catch (err: any) {
      logger.warn({ err: err?.message || err }, 'Failed initializing Supabase, falling back to local FileStore adapter');
    }
  }

  logger.info('Using local FileStore adapter for persistence');
  repositoryInstance = new FileStoreAdapter();
  return repositoryInstance;
}

export const repository = getRepository();
