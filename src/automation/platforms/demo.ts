import { Page } from 'playwright';
import { DEMO_BASE_URL, DEMO_PLATFORM } from '../../db/seed.js';
import { runMultiStep } from '../engine/multiStepRunner.js';
import { clickFirstVisible, firstVisible, settle, sleep, waitForAnyVisible } from '../engine/pageUtils.js';
import { applySinglePageForm } from './singlePageForm.js';
import { fetchJson, titleMatchesAny } from './shared.js';
import { DiscoveredJob, LoginOutcome, PlatformAdapter } from './types.js';

/**
 * Practice board served by this server under /mock-portal. It mirrors a real
 * platform (login, multi-step Easy-Apply style form, CAPTCHA variant) so the
 * whole pipeline can be exercised without touching a real employer.
 */
export const demoAdapter: PlatformAdapter = {
  id: DEMO_PLATFORM,
  name: 'Demo practice board',
  description: 'Local practice board for testing the full flow safely (login, multi-step form, CAPTCHA). No real employer receives anything.',
  requiresLogin: true,
  loginUrl: `${DEMO_BASE_URL}/login`,
  hidden: true,
  notes: 'Demo login: candidate@example.com / correct-horse',

  canHandleUrl(url: string) {
    return url.includes('/mock-portal/');
  },

  async search(ctx) {
    const data = await fetchJson<{ jobs: DiscoveredJob[] }>(`${DEMO_BASE_URL}/api/jobs`);
    return data.jobs.filter((j) => titleMatchesAny(j.title, ctx.query.keywords, 0.5)).slice(0, ctx.query.limit);
  },

  async isLoggedIn(page: Page) {
    await page.goto(`${DEMO_BASE_URL}/account`, { waitUntil: 'domcontentloaded' });
    return !page.url().includes('/login');
  },

  async login(page, creds): Promise<LoginOutcome> {
    await page.goto(`${DEMO_BASE_URL}/login`, { waitUntil: 'domcontentloaded' });
    const user = await waitForAnyVisible(page, ['#username'], 5000);
    if (!user) return { status: 'failed', reason: 'Demo login form not found' };
    await user.fill(creds.username);
    await page.locator('#password').fill(creds.password);
    await clickFirstVisible(page, ['button[type="submit"]']);
    await settle(page, 5000);
    if (page.url().includes('/verify')) return { status: 'challenge', reason: 'Demo board asked for a verification code.' };
    const error = await firstVisible(page, ['.error']);
    if (error) return { status: 'failed', reason: (await error.innerText()).trim() };
    return page.url().includes('/account') ? { status: 'logged_in' } : { status: 'failed', reason: 'Login did not complete' };
  },

  async apply(ctx) {
    const { page } = ctx;
    await page.goto(ctx.job.application_url, { waitUntil: 'domcontentloaded' });
    await settle(page, 5000);
    if (page.url().includes('/login')) {
      return { status: 'FAILED', message: 'Demo board session expired: reconnect it on the Platforms page.' };
    }

    if (page.url().includes('/mock-portal/job/')) {
      return applySinglePageForm(ctx, {
        formScope: ['#application-form'],
        submitButtons: ['[data-testid="submit-application"]'],
        verify: { successText: /application submitted/i, timeoutMs: 10000 },
      });
    }

    if (await firstVisible(page, ['text=You already applied'])) {
      return { status: 'ALREADY_APPLIED', message: 'Already applied on the demo board.' };
    }
    await clickFirstVisible(page, ['#easy-apply']);
    await sleep(300);
    return runMultiStep(ctx, {
      scope: '#apply-modal',
      submitButtons: ['button:has-text("Submit application")'],
      reviewButtons: ['button:has-text("Review")'],
      nextButtons: ['button:has-text("Next")'],
      errorSelectors: ['.field-error'],
      verify: { successText: /your application was sent/i, timeoutMs: 10000 },
    });
  },
};
