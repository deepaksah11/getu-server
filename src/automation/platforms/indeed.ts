import { Page } from 'playwright';
import { extractSkillsFromText } from '../../ai/skillDictionary.js';
import { NormalizedJob } from '../../types/index.js';
import { detectChallenge } from '../engine/challengeDetector.js';
import { runMultiStep } from '../engine/multiStepRunner.js';
import { clickFirstVisible, firstVisible, pause, settle, sleep, waitForAnyVisible } from '../engine/pageUtils.js';
import { relativeDateToIso, workModeFromText } from './shared.js';
import { DiscoveredJob, LoginOutcome, PlatformAdapter } from './types.js';

const INDIA_HINT = /india|bengaluru|bangalore|mumbai|delhi|noida|gurgaon|gurugram|hyderabad|pune|chennai|kolkata|ahmedabad/i;

function domainFor(location: string, profileLocation: string): string {
  return INDIA_HINT.test(`${location} ${profileLocation}`) ? 'https://in.indeed.com' : 'https://www.indeed.com';
}

interface IndeedCard {
  jk: string;
  title: string;
  company: string;
  location: string;
  snippet: string;
  easyApply: boolean;
  posted: string;
}

async function readCards(page: Page): Promise<IndeedCard[]> {
  return page.evaluate(() => {
    const clean = (t: string | null | undefined) => (t || '').replace(/\s+/g, ' ').trim();
    return Array.from(document.querySelectorAll('.job_seen_beacon, div.cardOutline')).map((card) => {
      const link = card.querySelector('a[data-jk], h2 a') as HTMLAnchorElement | null;
      const text = (card as HTMLElement).innerText || '';
      return {
        jk: link?.getAttribute('data-jk') || new URL(link?.href || 'https://x/?jk=', location.href).searchParams.get('jk') || '',
        title: clean(card.querySelector('h2 span[title]')?.getAttribute('title') || card.querySelector('h2')?.textContent),
        company: clean(card.querySelector('[data-testid="company-name"], .companyName')?.textContent),
        location: clean(card.querySelector('[data-testid="text-location"], .companyLocation')?.textContent),
        snippet: clean(card.querySelector('[data-testid="jobsnippet_footer"], .job-snippet, [class*="snippet"]')?.textContent),
        easyApply: /easily apply|responsive employer/i.test(text) || Boolean(card.querySelector('[data-testid="indeedApply"], .iaLabel')),
        posted: clean(card.querySelector('[data-testid="myJobsStateDate"], .date')?.textContent),
      };
    }).filter((c) => c.jk && c.title);
  });
}

export const indeedAdapter: PlatformAdapter = {
  id: 'Indeed',
  name: 'Indeed',
  description: '"Easily apply" jobs on Indeed. Applies with your Indeed account.',
  requiresLogin: true,
  loginUrl: 'https://secure.indeed.com/auth',
  searchNeedsBrowser: true,
  notes: 'Indeed usually signs in with a code sent to your email: use "Connect" and enter the code once in the browser window. Indeed blocks hidden browsers, so a minimized Chrome window opens while it works.',
  needsVisibleBrowser: true,

  canHandleUrl(url: string) {
    return /indeed\.com\//i.test(url);
  },

  async search(ctx) {
    if (!ctx.getPage) throw new Error('Indeed search needs a browser session');
    const page = await ctx.getPage();
    const { keywords, locations, limit, postedWithinDays } = ctx.query;
    const found = new Map<string, { card: IndeedCard; domain: string }>();

    outer: for (const keyword of keywords.slice(0, 4)) {
      for (const location of (locations.length ? locations : ['']).slice(0, 3)) {
        const domain = domainFor(location, ctx.profile.location || '');
        const params = new URLSearchParams({ q: keyword, l: location, fromage: String(Math.min(Math.max(postedWithinDays, 1), 14)) });
        // DSQF7 = Indeed's "Easily apply" filter
        params.set('sc', '0kf:attr(DSQF7);');
        await page.goto(`${domain}/jobs?${params.toString()}`, { waitUntil: 'domcontentloaded' });
        await waitForAnyVisible(page, ['.job_seen_beacon', '#jobsInLocation', 'text=/did not match any jobs/i'], 15000);
        if (/^blocked/i.test(await page.title())) {
          throw new Error('Indeed blocked the automated browser. Connect Indeed (it runs in a visible Chrome window) and try again later.');
        }
        const challenge = await detectChallenge(page);
        if (challenge.requiresHumanAction) {
          throw new Error(`Indeed showed a verification page: ${challenge.reason}. Use "Connect" for Indeed and try again.`);
        }
        for (const card of await readCards(page)) {
          if (card.easyApply && !found.has(card.jk)) found.set(card.jk, { card, domain });
        }
        if (found.size >= limit) break outer;
        await pause(1500, 3000);
      }
    }
    ctx.log('indeed_candidates', { found: found.size });
    return Array.from(found.values()).slice(0, limit).map(({ card, domain }): DiscoveredJob => ({
      external_id: card.jk,
      platform: 'Indeed',
      title: card.title,
      company: card.company || 'Unknown company',
      locations: card.location ? [card.location] : [],
      work_mode: workModeFromText(card.location),
      experience_required: 'Not specified',
      salary: 'Not disclosed',
      description: card.snippet,
      requirements: [],
      skills: extractSkillsFromText(`${card.title}\n${card.snippet}`),
      application_url: `${domain}/viewjob?jk=${card.jk}`,
      posted_at: relativeDateToIso(card.posted),
      extracted_metadata: { easy_apply: card.easyApply },
      is_active: true,
    }));
  },

  async enrich(job: NormalizedJob, getPage) {
    if (!getPage || (job.description && job.description.length > 400)) return null;
    const page = await getPage();
    await page.goto(job.application_url, { waitUntil: 'domcontentloaded' });
    const desc = await waitForAnyVisible(page, ['#jobDescriptionText'], 12000);
    if (!desc) return null;
    const description = (await desc.innerText()).trim();
    return { description, skills: extractSkillsFromText(`${job.title}\n${description}`).slice(0, 20) };
  },

  async isLoggedIn(page: Page) {
    await page.goto('https://myjobs.indeed.com/', { waitUntil: 'domcontentloaded' });
    await sleep(2500);
    return /myjobs\.indeed\.com/.test(page.url()) && !/secure\.indeed\.com\/auth/.test(page.url());
  },

  async login(page, creds): Promise<LoginOutcome> {
    await page.goto('https://secure.indeed.com/auth', { waitUntil: 'domcontentloaded' });
    await settle(page, 6000);
    let challenge = await detectChallenge(page);
    if (challenge.requiresHumanAction) return { status: 'challenge', reason: challenge.reason || 'Indeed security check' };
    const email = await waitForAnyVisible(page, ['input[type="email"]', 'input[name="__email"]'], 10000);
    if (!email) return { status: 'failed', reason: 'Indeed login form not found' };
    await email.fill(creds.username);
    await clickFirstVisible(page, ['button[type="submit"]', 'button:has-text("Continue")']);
    await sleep(3000);
    // Indeed often defaults to an emailed code; prefer password when offered
    await clickFirstVisible(page, ['a:has-text("Sign in with a password")', 'button:has-text("password instead")', 'a:has-text("password instead")']).catch(() => false);
    const password = await waitForAnyVisible(page, ['input[type="password"]'], 8000);
    if (password) {
      await password.fill(creds.password);
      await pause(300, 700);
      await clickFirstVisible(page, ['button[type="submit"]', 'button:has-text("Sign in")']);
    }
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      await sleep(1000);
      if (!/secure\.indeed\.com\/(auth|account\/login)/.test(page.url())) return { status: 'logged_in' };
      challenge = await detectChallenge(page);
      if (challenge.requiresHumanAction) return { status: 'challenge', reason: challenge.reason || 'Indeed sent a sign-in code' };
    }
    return { status: 'challenge', reason: 'Indeed is waiting for a sign-in code or verification.' };
  },

  async apply(ctx) {
    const { page } = ctx;
    await page.goto(ctx.job.application_url, { waitUntil: 'domcontentloaded' });
    await settle(page, 6000);
    const challenge = await detectChallenge(page);
    if (challenge.requiresHumanAction) {
      return { status: 'REQUIRES_HUMAN_ACTION', message: challenge.reason || 'Indeed verification page', screenshotPath: await ctx.screenshot('indeed_challenge') };
    }
    if (await firstVisible(page, ['text=/you applied|applied on/i', 'button:has-text("Applied")'])) {
      return { status: 'ALREADY_APPLIED', message: 'Indeed shows this job as already applied.' };
    }
    const applyButton = await waitForAnyVisible(page, ['#indeedApplyButton', 'button:has-text("Apply now")', 'button[aria-label*="Apply now"]'], 8000);
    if (!applyButton) {
      const external = await firstVisible(page, ['a:has-text("Apply on company site")', 'button:has-text("Apply on company site")']);
      if (external) {
        return { status: 'EXTERNAL', message: 'This Indeed job applies on the company website.', externalUrl: (await external.getAttribute('href')) || page.url() };
      }
      return { status: 'FAILED', message: 'Indeed apply button not found.', screenshotPath: await ctx.screenshot('indeed_no_apply') };
    }

    const popupPromise = ctx.context.waitForEvent('page', { timeout: 8000 }).catch(() => null);
    await applyButton.click();
    const popup = await popupPromise;
    const flowPage = popup || page;
    await settle(flowPage, 8000);
    if (/secure\.indeed\.com\/auth/.test(flowPage.url())) {
      return { status: 'FAILED', message: 'Indeed session expired: reconnect Indeed on the Platforms page.' };
    }

    const result = await runMultiStep(
      { ...ctx, page: flowPage, screenshot: async (label) => ctx.screenshot(label) },
      {
        scope: null,
        submitButtons: ['button:has-text("Submit your application")', 'button:has-text("Submit application")'],
        reviewButtons: ['button:has-text("Review your application")'],
        nextButtons: ['button:has-text("Continue")', 'button[data-testid*="continue"]'],
        overwrite: false,
        verify: {
          successText: /your application has been submitted|application submitted/i,
          timeoutMs: 15000,
        },
      }
    );
    if (popup && result.status !== 'SUBMITTED') await popup.close().catch(() => {});
    return result;
  },
};
