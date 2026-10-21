import { Page } from 'playwright';
import { extractSkillsFromText } from '../../ai/skillDictionary.js';
import { NormalizedJob } from '../../types/index.js';
import { runMultiStep } from '../engine/multiStepRunner.js';
import { bodyText, clickFirstVisible, firstVisible, pause, settle, sleep, waitForAnyVisible } from '../engine/pageUtils.js';
import { fetchText, htmlToText, mapLimit, workModeFromText } from './shared.js';
import { DiscoveredJob, LoginOutcome, PlatformAdapter } from './types.js';

const GUEST_SEARCH = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';
const GUEST_POSTING = 'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/';

interface GuestCard {
  id: string;
  title: string;
  company: string;
  location: string;
  postedAt?: string;
}

function decode(text: string): string {
  return htmlToText(text).replace(/\s+/g, ' ').trim();
}

export function parseGuestSearch(html: string): GuestCard[] {
  const cards: GuestCard[] = [];
  const chunks = html.split(/<li[\s>]/).slice(1);
  for (const chunk of chunks) {
    const id = chunk.match(/urn:li:jobPosting:(\d+)/)?.[1];
    if (!id) continue;
    const title = chunk.match(/base-search-card__title[^>]*>([\s\S]*?)<\/h3>/)?.[1];
    const subtitle = chunk.match(/base-search-card__subtitle[^>]*>([\s\S]*?)<\/h4>/)?.[1];
    const location = chunk.match(/job-search-card__location[^>]*>([\s\S]*?)<\/span>/)?.[1];
    const posted = chunk.match(/<time[^>]*datetime="([^"]+)"/)?.[1];
    if (!title) continue;
    cards.push({
      id,
      title: decode(title),
      company: decode(subtitle || ''),
      location: decode(location || ''),
      postedAt: posted ? new Date(posted).toISOString() : undefined,
    });
  }
  return cards;
}

export function parseGuestPosting(html: string): { description: string; criteria: Record<string, string>; offsite: boolean } {
  const descHtml = html.match(/show-more-less-html__markup[^>]*>([\s\S]*?)<\/div>/)?.[1] || '';
  const criteria: Record<string, string> = {};
  for (const m of html.matchAll(/description__job-criteria-subheader[^>]*>\s*([^<]+?)\s*<\/h3>\s*<span[^>]*>\s*([^<]+?)\s*<\/span>/g)) {
    criteria[m[1].trim()] = m[2].trim();
  }
  return { description: htmlToText(descHtml), criteria, offsite: /offsite-apply|apply-link-offsite/.test(html) };
}

const SENIORITY_TO_EXPERIENCE: Record<string, string> = {
  Internship: '0 years',
  'Entry level': '0-2 years',
  Associate: '1-3 years',
  'Mid-Senior level': '4+ years',
  Director: '10+ years',
  Executive: '12+ years',
};

function toDiscovered(card: GuestCard, details?: ReturnType<typeof parseGuestPosting>): DiscoveredJob {
  const description = details?.description || '';
  const seniority = details?.criteria['Seniority level'];
  return {
    external_id: card.id,
    platform: 'LinkedIn',
    title: card.title,
    company: card.company || 'Unknown company',
    locations: card.location ? [card.location] : [],
    work_mode: workModeFromText(`${card.location} ${card.title} ${description.slice(0, 600)}`),
    experience_required: (seniority && SENIORITY_TO_EXPERIENCE[seniority]) || 'Not specified',
    salary: 'Not disclosed',
    description,
    requirements: [],
    skills: extractSkillsFromText(`${card.title}\n${description}`).slice(0, 20),
    application_url: `https://www.linkedin.com/jobs/view/${card.id}/`,
    posted_at: card.postedAt,
    extracted_metadata: { easy_apply: details ? !details.offsite : true, criteria: details?.criteria },
    is_active: true,
  };
}

async function closeEasyApply(page: Page): Promise<void> {
  if (!(await clickFirstVisible(page, ['button[aria-label="Dismiss"]', '.artdeco-modal__dismiss']))) return;
  await sleep(700);
  await clickFirstVisible(page, [
    'button[data-control-name="discard_application_confirm_btn"]',
    'button:has-text("Discard")',
    'button[data-test-dialog-secondary-btn]',
  ]).catch(() => false);
}

export const linkedinAdapter: PlatformAdapter = {
  id: 'LinkedIn',
  name: 'LinkedIn',
  description: 'Easy Apply jobs on LinkedIn. Uses your LinkedIn account; searching works without login.',
  requiresLogin: true,
  loginUrl: 'https://www.linkedin.com/login',
  notes: 'Only Easy Apply jobs are applied to directly. LinkedIn may ask for a verification code on first login: use "Connect" to complete it once in the browser window.',

  canHandleUrl(url: string) {
    return /linkedin\.com\/jobs/i.test(url);
  },

  async search(ctx) {
    const { keywords, locations, limit, postedWithinDays } = ctx.query;
    const seconds = Math.max(1, postedWithinDays) * 86400;
    const cards = new Map<string, GuestCard>();
    const searchLocations = locations.length ? locations.slice(0, 3) : [''];

    outer: for (const keyword of keywords.slice(0, 4)) {
      for (const location of searchLocations) {
        const remote = /^remote$/i.test(location);
        for (let start = 0; start < 75; start += 25) {
          const params = new URLSearchParams({
            keywords: keyword,
            location: remote ? ctx.profile.location?.split(',').pop()?.trim() || 'India' : location,
            f_TPR: `r${seconds}`,
            f_AL: 'true',
            start: String(start),
          });
          if (remote) params.set('f_WT', '2');
          let html = '';
          try {
            html = await fetchText(`${GUEST_SEARCH}?${params.toString()}`);
          } catch (err: any) {
            ctx.log('linkedin_search_error', { keyword, location, error: err.message });
            break;
          }
          const page = parseGuestSearch(html);
          if (page.length === 0) break;
          for (const card of page) if (!cards.has(card.id)) cards.set(card.id, card);
          if (cards.size >= limit * 2) break outer;
          await sleep(800);
        }
      }
    }
    ctx.log('linkedin_candidates', { found: cards.size });

    const selected = Array.from(cards.values()).slice(0, limit);
    const enriched = await mapLimit(selected, 3, async (card) => {
      await sleep(300);
      const html = await fetchText(`${GUEST_POSTING}${card.id}`);
      return toDiscovered(card, parseGuestPosting(html));
    });
    return enriched.map((job, i) => job || toDiscovered(selected[i]));
  },

  async enrich(job: NormalizedJob) {
    if (job.description && job.description.length > 300) return null;
    const html = await fetchText(`${GUEST_POSTING}${job.external_id}`);
    const details = parseGuestPosting(html);
    return {
      description: details.description,
      skills: extractSkillsFromText(`${job.title}\n${details.description}`).slice(0, 20),
      extracted_metadata: { ...(job.extracted_metadata || {}), easy_apply: !details.offsite, criteria: details.criteria },
    };
  },

  async isLoggedIn(page: Page) {
    await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded' });
    await sleep(1500);
    const url = page.url();
    return /linkedin\.com\/feed/.test(url) && !/login|authwall|signup|checkpoint/.test(url);
  },

  async login(page, creds): Promise<LoginOutcome> {
    await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded' });
    await settle(page, 5000);
    if (/\/feed/.test(page.url())) return { status: 'logged_in' };

    const user = await waitForAnyVisible(page, ['#username', 'input[name="session_key"]', 'input[autocomplete="username"]', 'input[type="email"]'], 10000);
    const pass = await firstVisible(page, ['#password', 'input[name="session_password"]', 'input[type="password"]']);
    if (!user || !pass) return { status: 'failed', reason: 'LinkedIn login form not found' };
    await user.fill(creds.username);
    await pause(300, 700);
    await pass.fill(creds.password);
    await pause(300, 700);
    await clickFirstVisible(page, ['button[type="submit"]', 'button:has-text("Sign in")']);

    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      await sleep(1000);
      const url = page.url();
      if (/linkedin\.com\/(feed|in\/|jobs|mynetwork)/.test(url)) return { status: 'logged_in' };
      if (/checkpoint|challenge|add-phone|two-step/.test(url)) {
        return { status: 'challenge', reason: 'LinkedIn asked for a verification step (code, CAPTCHA or phone check).' };
      }
      const error = await firstVisible(page, ['#error-for-password', '#error-for-username', '.form__label--error', 'div[role="alert"]']);
      if (error) {
        const text = (await error.innerText().catch(() => '')).trim();
        if (text) return { status: 'failed', reason: text };
      }
    }
    return { status: 'challenge', reason: 'LinkedIn did not finish signing in; it may be waiting for a verification step.' };
  },

  async apply(ctx) {
    const { page } = ctx;
    await page.goto(`https://www.linkedin.com/jobs/view/${ctx.job.external_id}/`, { waitUntil: 'domcontentloaded' });
    await settle(page, 6000);
    if (/login|authwall|signup/.test(page.url())) {
      return { status: 'FAILED', message: 'LinkedIn session expired: reconnect LinkedIn on the Platforms page.' };
    }

    const text = await bodyText(page, 8000);
    if (/no longer accepting applications/i.test(text)) {
      return { status: 'FAILED', message: 'This LinkedIn job is no longer accepting applications.' };
    }
    if (/Applied\s+\d+\s+(second|minute|hour|day|week|month)s?\s+ago|Application submitted/i.test(text)) {
      return { status: 'ALREADY_APPLIED', message: 'LinkedIn shows you already applied to this job.' };
    }

    const easyApply = await waitForAnyVisible(
      page,
      [
        'button.jobs-apply-button:has-text("Easy Apply")',
        'button[aria-label*="Easy Apply"]',
        '.jobs-apply-button--top-card button:has-text("Easy Apply")',
      ],
      8000
    );
    if (!easyApply) {
      const external = await firstVisible(page, ['button.jobs-apply-button:has-text("Apply")', 'a.jobs-apply-button']);
      if (external) {
        const popupPromise = ctx.context.waitForEvent('page', { timeout: 10000 }).catch(() => null);
        await external.click().catch(() => {});
        const popup = await popupPromise;
        let externalUrl = popup ? popup.url() : page.url();
        if (popup) {
          await popup.waitForLoadState('domcontentloaded').catch(() => {});
          externalUrl = popup.url();
          await popup.close().catch(() => {});
        }
        return { status: 'EXTERNAL', message: 'This job applies on the company website.', externalUrl };
      }
      return { status: 'FAILED', message: 'Easy Apply button not found on the LinkedIn job page.', screenshotPath: await ctx.screenshot('linkedin_no_apply') };
    }

    await easyApply.click();
    const modalSelector = '.jobs-easy-apply-modal, div[data-test-modal-id="easy-apply-modal"], div.artdeco-modal[role="dialog"]';
    if (!(await waitForAnyVisible(page, [modalSelector], 10000))) {
      return { status: 'FAILED', message: 'The Easy Apply form did not open.', screenshotPath: await ctx.screenshot('linkedin_modal') };
    }

    const result = await runMultiStep(ctx, {
      scope: modalSelector,
      submitButtons: ['button[aria-label="Submit application"]', 'button:has-text("Submit application")'],
      reviewButtons: ['button[aria-label="Review your application"]', 'button:has-text("Review")'],
      nextButtons: ['button[aria-label="Continue to next step"]', 'button:has-text("Next")', 'button:has-text("Continue")'],
      errorSelectors: ['.artdeco-inline-feedback--error'],
      overwrite: false,
      beforeSubmit: async (p) => {
        const follow = p.locator('#follow-company-checkbox');
        if (await follow.isChecked().catch(() => false)) {
          await p.locator('label[for="follow-company-checkbox"]').click().catch(() => {});
        }
      },
      verify: {
        successText: /your application was sent|application sent|application submitted/i,
        successSelectors: ['h3:has-text("Your application was sent")', '[data-test-modal-id="post-apply-modal"]'],
        timeoutMs: 15000,
      },
    });

    if (result.status === 'SUBMITTED') {
      await clickFirstVisible(page, ['button[aria-label="Dismiss"]', 'button:has-text("Done")']).catch(() => false);
    } else {
      await closeEasyApply(page);
    }
    return result;
  },
};
