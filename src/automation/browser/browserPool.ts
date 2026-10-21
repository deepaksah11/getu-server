import fs from 'fs';
import path from 'path';
import { chromium, Browser, BrowserContext } from 'playwright';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { StorageState } from '../security/sessionStore.js';

/**
 * headless  – no window (default)
 * minimized – real window started minimized, for platforms that refuse headless browsers
 * visible   – normal window, used for interactive logins (OTP / CAPTCHA) or when the user wants to watch
 */
export type BrowserMode = 'headless' | 'minimized' | 'visible';

const CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
];
const EDGE_PATHS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/microsoft-edge',
];

class BrowserPool {
  private browsers = new Map<BrowserMode, Promise<Browser>>();
  private resolvedChannel: string | undefined | null = null;

  private channel(): string | undefined {
    if (this.resolvedChannel !== null) return this.resolvedChannel;
    let channel: string | undefined;
    if (env.BROWSER_CHANNEL === 'chrome' || env.BROWSER_CHANNEL === 'msedge') {
      channel = env.BROWSER_CHANNEL;
    } else if (env.BROWSER_CHANNEL === 'auto' && env.NODE_ENV !== 'test') {
      // A regular installed browser behaves like the user's own browser on job sites
      if (CHROME_PATHS.some((p) => p && fs.existsSync(p))) channel = 'chrome';
      else if (EDGE_PATHS.some((p) => fs.existsSync(p))) channel = 'msedge';
    }
    this.resolvedChannel = channel;
    return channel;
  }

  private async launch(mode: BrowserMode): Promise<Browser> {
    const channel = this.channel();
    const args = mode === 'minimized' ? ['--start-minimized'] : [];
    const options = { headless: mode === 'headless', args };
    try {
      logger.info({ mode, channel: channel || 'chromium' }, 'Launching browser');
      return await chromium.launch({ ...options, channel });
    } catch (err: any) {
      if (!channel) throw err;
      logger.warn({ channel, err: err.message.split('\n')[0] }, 'Installed browser failed to launch; using bundled Chromium');
      this.resolvedChannel = undefined;
      return chromium.launch(options);
    }
  }

  async getBrowser(mode: BrowserMode): Promise<Browser> {
    const existing = this.browsers.get(mode);
    if (existing) {
      try {
        const browser = await existing;
        if (browser.isConnected()) return browser;
      } catch {
        // fall through and relaunch
      }
      this.browsers.delete(mode);
    }
    const launching = this.launch(mode);
    this.browsers.set(mode, launching);
    try {
      const browser = await launching;
      browser.on('disconnected', () => {
        if (this.browsers.get(mode) === launching) this.browsers.delete(mode);
      });
      return browser;
    } catch (err) {
      this.browsers.delete(mode);
      throw err;
    }
  }

  async newContext(options: { mode?: BrowserMode; storageState?: StorageState } = {}): Promise<BrowserContext> {
    const browser = await this.getBrowser(options.mode || 'headless');
    const context = await browser.newContext({
      viewport: { width: 1366, height: 900 },
      locale: 'en-US',
      storageState: options.storageState as any,
    });
    context.setDefaultTimeout(env.BROWSER_TIMEOUT);
    context.setDefaultNavigationTimeout(Math.max(env.BROWSER_TIMEOUT, 45000));
    // esbuild (tsx/vitest) may wrap functions passed to page.evaluate in __name(); make it a no-op in pages
    await context.addInitScript('globalThis.__name = globalThis.__name || ((fn) => fn);');
    return context;
  }

  async closeAll(): Promise<void> {
    const all = Array.from(this.browsers.values());
    this.browsers.clear();
    await Promise.all(
      all.map(async (p) => {
        try {
          await (await p).close();
        } catch {
          // already closed
        }
      })
    );
  }
}

export const browserPool = new BrowserPool();
