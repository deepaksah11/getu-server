import { BrowserContext, Page } from 'playwright';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { getRepository } from '../db/client.js';
import { PlatformConnectionStatus } from '../types/index.js';
import { browserPool, BrowserMode } from './browser/browserPool.js';
import { sleep } from './engine/pageUtils.js';
import { getAdapter } from './platforms/registry.js';
import { LoginCredentials, LoginOutcome, PlatformAdapter } from './platforms/types.js';
import { sessionStore } from './security/sessionStore.js';
import { vault } from './security/vault.js';

export interface PlatformSession {
  ok: boolean;
  reason?: string;
  context: BrowserContext;
  page: Page;
  /** Persists cookies so the next run stays logged in */
  save(): Promise<void>;
  close(): Promise<void>;
}

/** URL fragments of login / verification pages; leaving them means the user finished signing in. */
const AUTH_URL = /login|signin|sign-in|auth|checkpoint|challenge|verify|otp|two-step|captcha|nlogin/i;

function key(userId: string, platform: string) {
  return `${userId}:${platform}`;
}

export class ConnectionManager {
  private connecting = new Map<string, Promise<void>>();

  isConnecting(userId: string, platform: string): boolean {
    return this.connecting.has(key(userId, platform));
  }

  browserModeFor(adapter: PlatformAdapter, showBrowser?: boolean): BrowserMode {
    if (showBrowser) return 'visible';
    if (adapter.needsVisibleBrowser) return 'minimized';
    return env.BROWSER_HEADLESS ? 'headless' : 'visible';
  }

  async saveCredentials(userId: string, platform: string, username: string, password?: string) {
    const adapter = getAdapter(platform);
    if (!adapter) throw new Error(`Unknown platform: ${platform}`);
    if (!adapter.requiresLogin) throw new Error(`${adapter.name} does not need a login`);
    const repo = getRepository();
    const existing = await repo.getCredential(userId, adapter.id);
    if (!password && !existing?.password_enc) throw new Error('Password is required');
    const changedLogin = !existing || existing.username !== username.trim() || Boolean(password);
    const saved = await repo.saveCredential(userId, adapter.id, {
      username: username.trim(),
      ...(password ? { password_enc: vault.encrypt(password) } : {}),
      ...(changedLogin ? { status: 'credentials_saved' as PlatformConnectionStatus, last_error: undefined } : {}),
    });
    if (changedLogin) await sessionStore.remove(userId, adapter.id);
    return saved;
  }

  async removeCredentials(userId: string, platform: string): Promise<void> {
    const adapter = getAdapter(platform);
    const id = adapter?.id || platform;
    await getRepository().deleteCredential(userId, id);
    await sessionStore.remove(userId, id);
  }

  async getLogin(userId: string, platform: string): Promise<LoginCredentials | null> {
    const cred = await getRepository().getCredential(userId, platform);
    if (!cred?.password_enc || !cred.username) return null;
    try {
      return { username: cred.username, password: vault.decrypt(cred.password_enc) };
    } catch {
      logger.error({ platform }, 'Stored password could not be decrypted (vault key changed?)');
      return null;
    }
  }

  private async setStatus(userId: string, platform: string, status: PlatformConnectionStatus, lastError?: string) {
    await getRepository().saveCredential(userId, platform, {
      status,
      last_error: lastError,
      ...(status === 'connected' ? { last_verified_at: new Date().toISOString() } : {}),
    });
  }

  /**
   * Starts signing in to a platform in the background. With `interactive` a
   * visible browser window opens so the user can complete OTP / CAPTCHA once.
   */
  startConnect(userId: string, platform: string, interactive: boolean): void {
    const adapter = getAdapter(platform);
    if (!adapter?.requiresLogin) throw new Error(`Unknown or login-free platform: ${platform}`);
    const k = key(userId, adapter.id);
    if (this.connecting.has(k)) return;
    const job = this.connect(userId, adapter, interactive)
      .catch(async (err) => {
        logger.error({ platform: adapter.id, err: err.message }, 'Platform connection failed');
        await this.setStatus(userId, adapter.id, 'failed', err.message?.split('\n')[0]).catch(() => {});
      })
      .finally(() => this.connecting.delete(k));
    this.connecting.set(k, job);
  }

  /** Waits for a running connection attempt (used by tests). */
  async waitForConnect(userId: string, platform: string): Promise<void> {
    await this.connecting.get(key(userId, platform));
  }

  private async connect(userId: string, adapter: PlatformAdapter, interactive: boolean): Promise<void> {
    const repo = getRepository();
    const login = await this.getLogin(userId, adapter.id);
    if (!login && !interactive) {
      await this.setStatus(userId, adapter.id, 'not_connected', 'Save your username and password first.');
      return;
    }
    if (!(await repo.getCredential(userId, adapter.id))) {
      await repo.saveCredential(userId, adapter.id, { username: '', status: 'connecting' });
    }
    await this.setStatus(userId, adapter.id, 'connecting');

    const prefs = await repo.getPreferences(userId);
    const mode: BrowserMode = interactive ? 'visible' : this.browserModeFor(adapter, prefs.show_browser);
    const storageState = await sessionStore.load(userId, adapter.id);
    const context = await browserPool.newContext({ mode, storageState });
    const page = await context.newPage();
    try {
      if (storageState && adapter.isLoggedIn && (await adapter.isLoggedIn(page))) {
        await sessionStore.save(userId, adapter.id, (await context.storageState()) as any);
        await this.setStatus(userId, adapter.id, 'connected');
        return;
      }

      let outcome: LoginOutcome = login
        ? await adapter.login!(page, login)
        : { status: 'challenge', reason: 'Sign in manually in the browser window.' };

      if (outcome.status === 'challenge' && interactive) {
        await this.setStatus(userId, adapter.id, 'awaiting_user', `${outcome.reason} Finish signing in in the browser window that opened.`);
        if (!login && adapter.loginUrl) await page.goto(adapter.loginUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
        outcome = await this.waitForUser(context, page, adapter);
      }

      if (outcome.status === 'logged_in') {
        await sessionStore.save(userId, adapter.id, (await context.storageState()) as any);
        await this.setStatus(userId, adapter.id, 'connected');
        logger.info({ platform: adapter.id }, 'Platform connected');
      } else if (outcome.status === 'challenge') {
        await this.setStatus(userId, adapter.id, 'needs_verification', `${outcome.reason} Click "Connect" to finish it in a browser window.`);
      } else {
        await this.setStatus(userId, adapter.id, 'failed', outcome.reason);
      }
    } finally {
      await context.close().catch(() => {});
    }
  }

  /** Polls until the user leaves the login/verification pages, then confirms the session in a background tab. */
  private async waitForUser(context: BrowserContext, page: Page, adapter: PlatformAdapter): Promise<LoginOutcome> {
    const deadline = Date.now() + env.INTERACTIVE_LOGIN_TIMEOUT_MINS * 60 * 1000;
    while (Date.now() < deadline) {
      await sleep(3000);
      if (page.isClosed()) return { status: 'challenge', reason: 'The browser window was closed before signing in finished.' };
      if (AUTH_URL.test(new URL(page.url()).pathname + new URL(page.url()).search)) continue;
      if (!adapter.isLoggedIn) return { status: 'logged_in' };
      const probe = await context.newPage();
      try {
        if (await adapter.isLoggedIn(probe)) return { status: 'logged_in' };
      } finally {
        await probe.close().catch(() => {});
      }
    }
    return { status: 'challenge', reason: `Signing in was not completed within ${env.INTERACTIVE_LOGIN_TIMEOUT_MINS} minutes.` };
  }

  /**
   * Opens a browser context for automation. For login platforms it reuses the
   * saved session and signs in again with the stored password when it expired.
   */
  async openSession(userId: string, platform: string, mode: BrowserMode): Promise<PlatformSession> {
    const adapter = getAdapter(platform);
    if (!adapter) throw new Error(`Unknown platform: ${platform}`);
    const storageState = adapter.requiresLogin ? await sessionStore.load(userId, adapter.id) : undefined;
    const context = await browserPool.newContext({ mode, storageState });
    const page = await context.newPage();
    const session: PlatformSession = {
      ok: true,
      context,
      page,
      save: async () => {
        if (adapter.requiresLogin) {
          await sessionStore.save(userId, adapter.id, (await context.storageState()) as any).catch((err) =>
            logger.warn({ platform: adapter.id, err: err.message }, 'Could not save browser session')
          );
        }
      },
      close: async () => {
        await session.save();
        await context.close().catch(() => {});
      },
    };
    if (!adapter.requiresLogin) return session;

    if (storageState && adapter.isLoggedIn) {
      try {
        if (await adapter.isLoggedIn(page)) {
          await this.setStatus(userId, adapter.id, 'connected');
          return session;
        }
      } catch (err: any) {
        logger.warn({ platform: adapter.id, err: err.message?.split('\n')[0] }, 'Session check failed');
      }
    }

    const login = await this.getLogin(userId, adapter.id);
    if (!login) {
      session.ok = false;
      session.reason = `Connect your ${adapter.name} account on the Platforms page first.`;
      return session;
    }
    const outcome = await adapter.login!(page, login).catch((err): LoginOutcome => ({ status: 'failed', reason: err.message?.split('\n')[0] }));
    if (outcome.status === 'logged_in') {
      await session.save();
      await this.setStatus(userId, adapter.id, 'connected');
      return session;
    }
    session.ok = false;
    session.reason =
      outcome.status === 'challenge'
        ? `${adapter.name} asked for verification (${outcome.reason}). Click "Connect" on the Platforms page to finish it once.`
        : `${adapter.name} login failed: ${outcome.reason}`;
    await this.setStatus(userId, adapter.id, outcome.status === 'challenge' ? 'needs_verification' : 'failed', session.reason);
    return session;
  }
}

export const connectionManager = new ConnectionManager();
