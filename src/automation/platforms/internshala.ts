import { Page } from 'playwright';
import { extractSkillsFromText } from '../../ai/skillDictionary.js';
import { NormalizedJob } from '../../types/index.js';
import { detectChallenge } from '../engine/challengeDetector.js';
import { clickFirstVisible, firstVisible, pause, settle, sleep, waitForAnyVisible } from '../engine/pageUtils.js';
import { applySinglePageForm } from './singlePageForm.js';
import { daysAgo, fetchText, htmlToText, locationMatches, relativeDateToIso, slugify, titleMatchesAny } from './shared.js';
import { DiscoveredJob, LoginOutcome, PlatformAdapter } from './types.js';

const BASE = 'https://internshala.com';

export function parseInternshalaListing(html: string, kind: 'job' | 'internship'): DiscoveredJob[] {
  const chunks = html.split(/class="container-fluid individual_internship/).slice(1);
  const jobs: DiscoveredJob[] = [];
  for (const chunk of chunks) {
    const id = chunk.match(/internshipId="(\d+)"/i)?.[1];
    const href = chunk.match(/data-href='([^']+)'/)?.[1] || chunk.match(/data-href="([^"]+)"/)?.[1];
    const title = chunk.match(/job-title-href[^>]*>([^<]+)</)?.[1];
    if (!id || !href || !title) continue;
    // Class attributes sometimes contain line breaks, so whitespace is matched loosely
    const company = chunk.match(/class="company-name"[^>]*>\s*([^<]+)/)?.[1] || '';
    const locationHtml = chunk.match(/row-1-item\s+locations[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/)?.[1] || '';
    const location = htmlToText(locationHtml).replace(/\s+/g, ' ').trim();
    const salary = chunk.match(/ic-16-money[\s\S]*?<span\s+class="desktop"[^>]*>\s*([^<]+)/)?.[1]?.trim() || 'Not disclosed';
    const experience = chunk.match(/ic-16-briefcase[\s\S]*?<span[^>]*>\s*([^<]+)/)?.[1]?.trim();
    const snippet = htmlToText(chunk.match(/about_job[\s\S]*?class="text"[^>]*>([\s\S]*?)<\/div>/)?.[1] || '');
    const skills = Array.from(chunk.matchAll(/class=['"]job_skill['"]>([^<]+)</g)).map((m) => m[1].trim());
    const posted = chunk.match(/ic-16-reschedule[\s\S]*?<span[^>]*>\s*([^<]+)/)?.[1];
    const remote = /work from home/i.test(location);
    jobs.push({
      external_id: id,
      platform: 'Internshala',
      title: htmlToText(title),
      company: htmlToText(company) || 'Unknown company',
      locations: remote ? ['Remote'] : location.split(/,\s*/).filter(Boolean),
      work_mode: remote ? 'Remote' : 'Onsite',
      experience_required: experience || (kind === 'internship' ? '0 years' : 'Not specified'),
      salary,
      description: snippet,
      requirements: [],
      skills: skills.length ? skills : extractSkillsFromText(snippet),
      application_url: `${BASE}${href}`,
      posted_at: relativeDateToIso(posted || ''),
      extracted_metadata: { kind },
      is_active: true,
    });
  }
  return jobs;
}

export const internshalaAdapter: PlatformAdapter = {
  id: 'Internshala',
  name: 'Internshala',
  description: 'Fresher jobs and internships on Internshala. Applies with your Internshala account.',
  requiresLogin: true,
  loginUrl: `${BASE}/login/user`,
  notes: 'Internshala applies with your Internshala profile resume; the cover letter and screening answers are written per job.',

  canHandleUrl(url: string) {
    return /internshala\.com\//i.test(url);
  },

  async search(ctx) {
    const { keywords, locations, limit, postedWithinDays } = ctx.query;
    const kinds: ('job' | 'internship')[] = (ctx.profile.years_of_experience || 0) < 1 ? ['job', 'internship'] : ['job'];
    const found = new Map<string, DiscoveredJob>();
    for (const kind of kinds) {
      for (const keyword of keywords.slice(0, 4)) {
        const url = `${BASE}/${kind === 'job' ? 'jobs' : 'internships'}/keywords-${slugify(keyword)}/`;
        let html = '';
        try {
          html = await fetchText(url);
        } catch (err: any) {
          ctx.log('internshala_search_error', { keyword, error: err.message });
          continue;
        }
        for (const job of parseInternshalaListing(html, kind)) {
          if (found.has(job.external_id)) continue;
          // Internshala's keyword search is fuzzy: keep titles that match the search
          if (!titleMatchesAny(job.title, keywords)) continue;
          if (!locationMatches(job.locations, locations, job.work_mode === 'Remote')) continue;
          if (postedWithinDays > 0 && job.posted_at && daysAgo(job.posted_at) > Math.max(postedWithinDays * 2, 21)) continue;
          found.set(job.external_id, job);
        }
        if (found.size >= limit) break;
        await sleep(600);
      }
    }
    ctx.log('internshala_candidates', { found: found.size });
    return Array.from(found.values()).slice(0, limit);
  },

  async enrich(job: NormalizedJob) {
    if (job.description && job.description.length > 400) return null;
    const html = await fetchText(job.application_url);
    const description = htmlToText(html.match(/class="text-container"[^>]*>([\s\S]*?)<\/div>/)?.[1] || '');
    if (!description) return null;
    return { description, skills: Array.from(new Set([...(job.skills || []), ...extractSkillsFromText(description)])).slice(0, 20) };
  },

  async isLoggedIn(page: Page) {
    await page.goto(`${BASE}/student/dashboard`, { waitUntil: 'domcontentloaded' });
    await sleep(2000);
    return /student\//.test(page.url()) && !/login/.test(page.url());
  },

  async login(page, creds): Promise<LoginOutcome> {
    await page.goto(`${BASE}/login/user`, { waitUntil: 'domcontentloaded' });
    await settle(page, 5000);
    if (/student\//.test(page.url())) return { status: 'logged_in' };
    const email = await waitForAnyVisible(page, ['input#email', 'input[name="email"]'], 10000);
    const password = await firstVisible(page, ['input#password', 'input[name="password"]']);
    if (!email || !password) return { status: 'failed', reason: 'Internshala login form not found' };
    await email.fill(creds.username);
    await pause(300, 600);
    await password.fill(creds.password);
    await pause(300, 600);
    await clickFirstVisible(page, ['#login_submit', 'button[type="submit"]:has-text("Login")', 'button[type="submit"]']);
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      await sleep(1000);
      if (/student\/|dashboard/.test(page.url())) return { status: 'logged_in' };
      const challenge = await detectChallenge(page);
      if (challenge.requiresHumanAction) return { status: 'challenge', reason: challenge.reason || 'Internshala verification' };
      const error = await firstVisible(page, ['.login-error', '#login-error', '.error_message', 'text=/incorrect|invalid/i']);
      if (error) return { status: 'failed', reason: (await error.innerText().catch(() => 'Invalid credentials')).trim() };
    }
    return { status: 'challenge', reason: 'Internshala did not finish signing in.' };
  },

  async apply(ctx) {
    const { page } = ctx;
    await page.goto(ctx.job.application_url, { waitUntil: 'domcontentloaded' });
    await settle(page, 6000);
    if (await firstVisible(page, ['button:has-text("Applied")', 'text=/already applied/i'])) {
      return { status: 'ALREADY_APPLIED', message: 'Internshala shows this job as already applied.' };
    }
    const applyNow = await waitForAnyVisible(page, ['#continue_button', 'button:has-text("Apply now")', '#easy_apply_button', '.apply_now_button'], 8000);
    if (!applyNow) {
      return { status: 'FAILED', message: 'Apply button not found on the Internshala page.', screenshotPath: await ctx.screenshot('internshala_no_apply') };
    }
    await applyNow.click();
    await sleep(2500);
    if (/login/.test(page.url()) || (await firstVisible(page, ['#login_submit']))) {
      return { status: 'FAILED', message: 'Internshala session expired: reconnect Internshala on the Platforms page.' };
    }
    // Some listings show an intermediate "Proceed to application" step
    await clickFirstVisible(page, ['button:has-text("Proceed to application")', 'a:has-text("Proceed to application")']).catch(() => false);
    await sleep(1500);
    return applySinglePageForm(ctx, {
      formScope: ['form#application-form', '#application_form', 'form:has(#submit)', '.application-form'],
      submitButtons: ['#submit', 'input[type="submit"]', 'button:has-text("Submit")'],
      overwrite: false,
      verify: {
        successText: /application (has been )?submitted|applied successfully|you have successfully applied/i,
        successUrl: /application.*success|student\/applications/i,
        timeoutMs: 15000,
      },
    });
  },
};
