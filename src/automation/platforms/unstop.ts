import { Page } from 'playwright';
import { detectChallenge } from '../engine/challengeDetector.js';
import { runMultiStep } from '../engine/multiStepRunner.js';
import { clickFirstVisible, firstVisible, pause, settle, sleep, waitForAnyVisible } from '../engine/pageUtils.js';
import { daysAgo, fetchJson, htmlToText, locationMatches, titleMatchesAny } from './shared.js';
import { DiscoveredJob, LoginOutcome, PlatformAdapter } from './types.js';

interface UnstopItem {
  id: number;
  title: string;
  seo_url?: string;
  public_url?: string;
  organisation?: { name?: string };
  details?: string;
  jobDetail?: {
    locations?: string[];
    type?: string;
    min_experience?: number | null;
    max_experience?: number | null;
    show_salary?: number;
    min_salary?: number | null;
    max_salary?: number | null;
  };
  locations?: { city?: string; state?: string; country?: string }[];
  required_skills?: { skill_name?: string; skill?: string }[];
  end_date?: string;
  approved_date?: string;
  updated_at?: string;
}

const SEARCH_API = 'https://unstop.com/api/public/opportunity/search-result';

function toDiscovered(item: UnstopItem, kind: 'jobs' | 'internships'): DiscoveredJob {
  const d = item.jobDetail || {};
  const type = (d.type || '').toLowerCase();
  const cities = d.locations?.length ? d.locations : (item.locations || []).map((l) => l.city).filter(Boolean) as string[];
  const exp =
    d.min_experience !== null && d.min_experience !== undefined
      ? `${d.min_experience}${d.max_experience ? `-${d.max_experience}` : '+'} years`
      : kind === 'internships' ? '0 years' : 'Not specified';
  const salary = d.show_salary && d.min_salary ? `₹${d.min_salary}${d.max_salary ? ` - ₹${d.max_salary}` : ''}` : 'Not disclosed';
  const description = htmlToText(item.details || '');
  const approved = item.approved_date ? Date.parse(item.approved_date.replace(' GMT', 'GMT')) : NaN;
  return {
    external_id: String(item.id),
    platform: 'Unstop',
    title: item.title,
    company: item.organisation?.name || 'Unknown company',
    locations: type.includes('wfh') || type.includes('remote') ? ['Remote', ...cities] : cities,
    work_mode: type.includes('wfh') || type.includes('remote') ? 'Remote' : type.includes('hybrid') ? 'Hybrid' : type.includes('office') ? 'Onsite' : 'Flexible',
    experience_required: exp,
    salary,
    description,
    requirements: [],
    skills: (item.required_skills || []).map((s) => s.skill_name || s.skill || '').filter(Boolean),
    application_url: item.seo_url || `https://unstop.com/${item.public_url}`,
    posted_at: !Number.isNaN(approved) ? new Date(approved).toISOString() : item.updated_at,
    extracted_metadata: { deadline: item.end_date, kind },
    is_active: true,
  };
}

export const unstopAdapter: PlatformAdapter = {
  id: 'Unstop',
  name: 'Unstop',
  description: 'Jobs and internships on Unstop (formerly Dare2Compete). Applies with your Unstop account.',
  requiresLogin: true,
  loginUrl: 'https://unstop.com/auth/login?login_as=candidate',
  notes: 'Uses email + password login. Accounts created with Google sign-in need a password set on Unstop first, or use "Connect" to sign in manually once.',

  canHandleUrl(url: string) {
    return /unstop\.com\//i.test(url);
  },

  async search(ctx) {
    const { keywords, locations, limit, postedWithinDays } = ctx.query;
    const kinds: ('jobs' | 'internships')[] = (ctx.profile.years_of_experience || 0) < 1 ? ['jobs', 'internships'] : ['jobs'];
    const found = new Map<string, DiscoveredJob>();
    for (const kind of kinds) {
      for (const keyword of keywords.slice(0, 4)) {
        const params = new URLSearchParams({ opportunity: kind, page: '1', per_page: '30', searchTerm: keyword, oppstatus: 'open' });
        let items: UnstopItem[] = [];
        try {
          const data = await fetchJson<{ data: { data: UnstopItem[] } }>(`${SEARCH_API}?${params.toString()}`);
          items = data.data?.data || [];
        } catch (err: any) {
          ctx.log('unstop_search_error', { keyword, error: err.message });
          continue;
        }
        for (const item of items) {
          const job = toDiscovered(item, kind);
          if (found.has(job.external_id)) continue;
          if (!titleMatchesAny(job.title, keywords)) continue;
          if (!locationMatches(job.locations, locations, job.work_mode === 'Remote')) continue;
          if (postedWithinDays > 0 && job.posted_at && daysAgo(job.posted_at) > Math.max(postedWithinDays * 2, 30)) continue;
          found.set(job.external_id, job);
        }
        if (found.size >= limit) break;
        await sleep(500);
      }
    }
    ctx.log('unstop_candidates', { found: found.size });
    return Array.from(found.values()).slice(0, limit);
  },

  async isLoggedIn(page: Page) {
    await page.goto('https://unstop.com/user/profile', { waitUntil: 'domcontentloaded' });
    await sleep(3000);
    return !/auth\/login/.test(page.url());
  },

  async login(page, creds): Promise<LoginOutcome> {
    await page.goto('https://unstop.com/auth/login?login_as=candidate', { waitUntil: 'domcontentloaded' });
    await settle(page, 6000);
    await clickFirstVisible(page, ['button:has-text("Ok, Continue")']).catch(() => false);
    const email = await waitForAnyVisible(page, ['input#email', 'input[type="email"]'], 12000);
    if (!email) return { status: 'failed', reason: 'Unstop login form not found' };
    await email.fill(creds.username);
    await clickFirstVisible(page, ['a:has-text("Login via Password")', 'text=Login via Password']);
    const password = await waitForAnyVisible(page, ['input#pwd', 'input[type="password"]'], 8000);
    if (!password) return { status: 'challenge', reason: 'Unstop asked for an OTP instead of a password.' };
    await password.fill(creds.password);
    await pause(300, 700);
    await clickFirstVisible(page, ['button.gtm_login_btn', 'button:has-text("Continue")', 'button[type="submit"]']);

    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      await sleep(1000);
      if (!/auth\/login/.test(page.url())) return { status: 'logged_in' };
      const challenge = await detectChallenge(page);
      if (challenge.requiresHumanAction) return { status: 'challenge', reason: challenge.reason || 'Unstop verification' };
      const error = await firstVisible(page, ['.error-msg', 'mat-error', '[class*="error"]:has-text("password")', 'text=/incorrect|invalid/i']);
      if (error) return { status: 'failed', reason: (await error.innerText().catch(() => 'Invalid credentials')).trim() };
    }
    return { status: 'challenge', reason: 'Unstop did not finish signing in.' };
  },

  async apply(ctx) {
    const { page } = ctx;
    await page.goto(ctx.job.application_url, { waitUntil: 'domcontentloaded' });
    await settle(page, 8000);
    await clickFirstVisible(page, ['button:has-text("Ok, Continue")']).catch(() => false);
    const challenge = await detectChallenge(page);
    if (challenge.requiresHumanAction) {
      return { status: 'REQUIRES_HUMAN_ACTION', message: challenge.reason || 'Unstop verification', screenshotPath: await ctx.screenshot('unstop_challenge') };
    }
    if (await firstVisible(page, ['button:has-text("Applied")', 'button:has-text("Registered")', 'text=/you have (already )?(applied|registered)/i'])) {
      return { status: 'ALREADY_APPLIED', message: 'Unstop shows this opportunity as already applied.' };
    }
    const applyButton = await waitForAnyVisible(page, ['button:has-text("Apply Now")', 'button:has-text("Apply")', 'button:has-text("Register")', 'a:has-text("Apply Now")'], 10000);
    if (!applyButton) {
      return { status: 'FAILED', message: 'Apply button not found on the Unstop page (registrations may be closed).', screenshotPath: await ctx.screenshot('unstop_no_apply') };
    }
    await applyButton.click();
    await sleep(3000);
    if (/auth\/login/.test(page.url()) || (await firstVisible(page, ['input#pwd', 'text=Login via Password']))) {
      return { status: 'FAILED', message: 'Unstop session expired: reconnect Unstop on the Platforms page.' };
    }

    const dialog = await waitForAnyVisible(page, ['[role="dialog"]', '.cdk-overlay-pane', 'app-registration', '[class*="registration"]'], 8000);
    const scope = dialog ? '[role="dialog"], .cdk-overlay-pane, app-registration, [class*="registration"]' : null;
    return runMultiStep(ctx, {
      scope,
      submitButtons: ['button:has-text("Submit")', 'button:has-text("Register")', 'button:has-text("Confirm")'],
      nextButtons: ['button:has-text("Next")', 'button:has-text("Save & Next")', 'button:has-text("Continue")'],
      overwrite: false,
      verify: {
        successText: /registered successfully|successfully registered|application (submitted|received)|applied successfully|you have (successfully )?applied|registration (is )?complete/i,
        timeoutMs: 15000,
      },
    });
  },
};
