/**
 * Read-only checks against the real job platforms. Run with:  LIVE_TESTS=1 npx vitest run
 * Nothing is typed, uploaded or submitted: searches use public endpoints and the
 * form checks only scan fields and compute the answers that would be used.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { browserPool } from '../../automation/browser/browserPool.js';
import { scanFields } from '../../automation/engine/fieldScanner.js';
import { FormAnswerer } from '../../automation/engine/answerEngine.js';
import { greenhouseAdapter } from '../../automation/platforms/greenhouse.js';
import { leverAdapter } from '../../automation/platforms/lever.js';
import { ashbyAdapter } from '../../automation/platforms/ashby.js';
import { linkedinAdapter } from '../../automation/platforms/linkedin.js';
import { unstopAdapter } from '../../automation/platforms/unstop.js';
import { internshalaAdapter } from '../../automation/platforms/internshala.js';
import { indeedAdapter } from '../../automation/platforms/indeed.js';
import { DiscoveredJob, PlatformAdapter, SearchQuery } from '../../automation/platforms/types.js';
import { initialPreferences, initialProfile } from '../../db/seed.js';
import { CandidateProfile, NormalizedJob } from '../../types/index.js';
import { testCandidate } from '../fixtures.js';

const profile = { ...initialProfile, ...testCandidate('live-user') } as CandidateProfile;
const prefs = { ...initialPreferences };
const found: Record<string, DiscoveredJob[]> = {};

async function search(adapter: PlatformAdapter, query: Partial<SearchQuery>, withBrowser = false) {
  const context = withBrowser ? await browserPool.newContext({ mode: 'headless' }) : null;
  const page = context ? await context.newPage() : null;
  try {
    const jobs = await adapter.search({
      query: { keywords: ['Software Engineer'], locations: [], limit: 5, postedWithinDays: 14, ...query },
      prefs,
      profile,
      getPage: page ? async () => page : undefined,
      log: () => undefined,
    });
    found[adapter.id] = jobs;
    console.log(`\n${adapter.id}: ${jobs.length} jobs`);
    for (const j of jobs.slice(0, 3)) console.log(`  - ${j.title} | ${j.company} | ${j.locations.join('; ')} | ${j.application_url}`);
    return jobs;
  } finally {
    await context?.close();
  }
}

function expectWellFormed(jobs: DiscoveredJob[], minDescription = 40) {
  expect(jobs.length).toBeGreaterThan(0);
  for (const j of jobs) {
    expect(j.title.length).toBeGreaterThan(2);
    expect(j.company.length).toBeGreaterThan(1);
    expect(j.application_url).toMatch(/^https:\/\//);
    expect(j.external_id).toBeTruthy();
  }
  expect(jobs.some((j) => j.description.length >= minDescription)).toBe(true);
}

/** Opens a real application form and reports what would be filled, without interacting. */
async function planForm(url: string, scope: string | null, platform: string) {
  const context = await browserPool.newContext({ mode: 'headless' });
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    const fields = await scanFields(page, scope && (await page.locator(scope).count()) > 0 ? scope : null);
    const job = { title: 'Software Engineer', company: 'Test', platform, skills: [], locations: [], description: '' } as unknown as NormalizedJob;
    const answerer = new FormAnswerer('live-user', profile, job, []);
    const plan: { label: string; kind: string; required: boolean; answer: string | null }[] = [];
    for (const f of fields) {
      if (f.kind === 'file') {
        plan.push({ label: f.label, kind: 'file', required: f.required, answer: f.isCoverLetter ? 'cover letter PDF' : 'tailored resume PDF' });
        continue;
      }
      let options = f.options;
      if (f.kind === 'combobox') {
        // Open the dropdown only to read its options (no typing), then close it
        const box = page.locator(`[data-aa-id="${f.key}"]`).first();
        await box.click({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(400);
        options = (await page.locator('[role="option"]:visible').allInnerTexts().catch(() => [] as string[])).map((t) => t.trim()).filter(Boolean);
        await page.keyboard.press('Escape').catch(() => {});
      }
      const result =
        f.kind === 'combobox' && options.length === 0
          ? null
          : await answerer.answer({ label: f.label, kind: f.kind, options: options.length && options.length <= 250 ? options : undefined, required: f.required });
      plan.push({ label: f.label, kind: f.kind, required: f.required, answer: result?.answer ?? null });
    }
    console.log(`\nForm plan for ${url}`);
    for (const p of plan) console.log(`  ${p.required ? '*' : ' '} [${p.kind}] ${p.label.slice(0, 70)} => ${p.answer === null ? '(needs user / opened at fill time)' : p.answer.slice(0, 60)}`);
    return plan;
  } finally {
    await context.close();
  }
}

afterAll(async () => {
  await browserPool.closeAll();
});

describe('Live job search (read-only)', () => {
  it('Greenhouse boards', async () => expectWellFormed(await search(greenhouseAdapter, {}), 200));
  it('Lever boards', async () => expectWellFormed(await search(leverAdapter, {}), 200));
  it('Ashby boards', async () => expectWellFormed(await search(ashbyAdapter, {}), 200));
  it('LinkedIn (guest search + posting details)', async () => expectWellFormed(await search(linkedinAdapter, { locations: ['Bengaluru'], keywords: ['React Developer'], limit: 3 }), 100));
  it('Unstop public search', async () => expectWellFormed(await search(unstopAdapter, { keywords: ['Developer'], locations: [] }), 40));
  it('Internshala listings', async () => expectWellFormed(await search(internshalaAdapter, { keywords: ['Software Engineer'], locations: [] }), 20));
  it('Indeed (browser search) returns jobs or a clear "blocked" explanation', async () => {
    // Indeed blocks headless browsers after a few requests; real runs use a visible window and your session
    try {
      const jobs = await search(indeedAdapter, { keywords: ['React Developer'], locations: ['Bangalore'], limit: 5 }, true);
      expect(jobs.length).toBeGreaterThan(0);
    } catch (err: any) {
      expect(err.message).toMatch(/Indeed blocked the automated browser|verification page/);
    }
  });
  it('India-focused location filtering keeps only India / remote jobs', async () => {
    const jobs = await search(greenhouseAdapter, { locations: ['Bengaluru', 'Remote'], limit: 10 });
    for (const j of jobs) expect(j.locations.join(' ')).toMatch(/bengaluru|bangalore|india|remote|anywhere/i);
  });
});

describe('Live application forms: field detection and answers (no typing, no submit)', () => {
  it('Greenhouse form', async () => {
    const job = found.Greenhouse?.[0];
    expect(job).toBeDefined();
    const plan = await planForm(job!.application_url, '#application-form, form#application_form, form:has(#first_name)', 'Greenhouse');
    const labels = plan.map((p) => p.label.toLowerCase());
    expect(labels.some((l) => l.includes('first name'))).toBe(true);
    expect(plan.find((p) => /first name/i.test(p.label))?.answer).toBe('Priya');
    expect(plan.find((p) => /^email/i.test(p.label))?.answer).toBe('priya.sharma@testmail.dev');
    expect(plan.some((p) => p.kind === 'file')).toBe(true);
  });

  it('Lever form', async () => {
    const job = found.Lever?.[0];
    expect(job).toBeDefined();
    const plan = await planForm(job!.application_url, '#application-form, form[action*="/apply"]', 'Lever');
    expect(plan.find((p) => /full name/i.test(p.label))?.answer).toBe('Priya Sharma');
    expect(plan.find((p) => /^email/i.test(p.label))?.answer).toBe('priya.sharma@testmail.dev');
    expect(plan.find((p) => /linkedin/i.test(p.label))?.answer).toBe('https://linkedin.com/in/priya-sharma-dev');
  });

  it('Ashby form', async () => {
    const job = found.Ashby?.[0];
    expect(job).toBeDefined();
    const plan = await planForm(job!.application_url, 'form:has(input[name="_systemfield_email"])', 'Ashby');
    expect(plan.find((p) => /name/i.test(p.label))?.answer).toMatch(/Priya/);
    expect(plan.find((p) => /email/i.test(p.label))?.answer).toBe('priya.sharma@testmail.dev');
  });
});
