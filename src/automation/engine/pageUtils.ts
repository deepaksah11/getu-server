import fs from 'fs/promises';
import path from 'path';
import { Locator, Page } from 'playwright';
import { paths } from '../../config/paths.js';
import { logger } from '../../config/logger.js';

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Short randomized pause between UI actions so the bot does not hammer pages. */
export async function pause(minMs = 300, maxMs = 900): Promise<void> {
  await sleep(minMs + Math.floor(Math.random() * Math.max(0, maxMs - minMs)));
}

type Scope = Page | Locator;

/** Returns the first selector that resolves to a visible element. */
export async function firstVisible(scope: Scope, selectors: string[]): Promise<Locator | null> {
  for (const selector of selectors) {
    try {
      const all = scope.locator(selector);
      const count = await all.count();
      for (let i = 0; i < Math.min(count, 5); i++) {
        const candidate = all.nth(i);
        if (await candidate.isVisible().catch(() => false)) return candidate;
      }
    } catch {
      // invalid selector for this engine version; try the next one
    }
  }
  return null;
}

/** Polls until one of the selectors is visible, or the timeout passes. */
export async function waitForAnyVisible(scope: Scope, selectors: string[], timeoutMs: number): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;
  do {
    const found = await firstVisible(scope, selectors);
    if (found) return found;
    await sleep(300);
  } while (Date.now() < deadline);
  return null;
}

export async function clickFirstVisible(scope: Scope, selectors: string[]): Promise<boolean> {
  const target = await firstVisible(scope, selectors);
  if (!target) return false;
  await target.scrollIntoViewIfNeeded().catch(() => {});
  await target.click({ timeout: 10000 }).catch(async () => {
    await target.click({ force: true, timeout: 5000 });
  });
  return true;
}

export async function bodyText(page: Page, max = 20000): Promise<string> {
  try {
    const text = await page.evaluate(() => document.body?.innerText || '');
    return text.slice(0, max);
  } catch {
    return '';
  }
}

export async function takeScreenshot(page: Page, label: string): Promise<string | undefined> {
  try {
    await fs.mkdir(paths.screenshotsDir, { recursive: true });
    const file = path.join(paths.screenshotsDir, `${label.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80)}_${Date.now()}.png`);
    await page.screenshot({ path: file, fullPage: true, timeout: 15000 });
    return file;
  } catch (err: any) {
    logger.warn({ err: err.message?.split('\n')[0] }, 'Screenshot failed');
    return undefined;
  }
}

/** Waits for the page to settle without failing on long-polling sites. */
export async function settle(page: Page, timeoutMs = 5000): Promise<void> {
  await page.waitForLoadState('domcontentloaded', { timeout: timeoutMs }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: timeoutMs }).catch(() => {});
}

export function decodeHtml(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;|&rsquo;|&lsquo;/g, "'")
    .replace(/&rdquo;|&ldquo;/g, '"')
    .replace(/&mdash;|&ndash;/g, '-')
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}
