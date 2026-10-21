import { Page } from 'playwright';
import { extractSkillsFromText } from '../../ai/skillDictionary.js';
import { NormalizedJob } from '../../types/index.js';
import { detectChallenge } from '../engine/challengeDetector.js';
import { bodyText, clickFirstVisible, firstVisible, pause, settle, sleep, waitForAnyVisible } from '../engine/pageUtils.js';
import { verifySubmission } from '../engine/submissionVerifier.js';
import { relativeDateToIso, slugify, workModeFromText } from './shared.js';
import { ApplyContext, ApplyResult, DiscoveredJob, LoginOutcome, PlatformAdapter } from './types.js';

const JOB_AGE_STEPS = [1, 3, 7, 15, 30];

interface NaukriCard {
  id: string;
  title: string;
  url: string;
  company: string;
  experience: string;
  salary: string;
  location: string;
  snippet: string;
  tags: string[];
  posted: string;
}

async function readSearchResults(page: Page): Promise<NaukriCard[]> {
  return page.evaluate(() => {
    const clean = (t: string | null | undefined) => (t || '').replace(/\s+/g, ' ').trim();
    return Array.from(document.querySelectorAll('.srp-jobtuple-wrapper[data-job-id], article.jobTuple')).map((card) => {
      const link = card.querySelector('a.title') as HTMLAnchorElement | null;
      return {
        id: card.getAttribute('data-job-id') || card.getAttribute('data-job-id') || '',
        title: clean(link?.getAttribute('title') || link?.textContent),
        url: link?.href || '',
        company: clean(card.querySelector('.comp-name, a.subTitle')?.textContent),
        experience: clean(card.querySelector('.expwdth, .exp-wrap span[title]')?.textContent),
        salary: clean(card.querySelector('.sal-wrap span[title], .salary')?.textContent),
        location: clean(card.querySelector('.locWdth, .loc-wrap span[title]')?.textContent),
        snippet: clean(card.querySelector('.job-desc, .job-description')?.textContent),
        tags: Array.from(card.querySelectorAll('ul.tags-gt li, .tags li')).map((li) => clean(li.textContent)).filter(Boolean),
        posted: clean(card.querySelector('.job-post-day, .fleft.postedDate')?.textContent),
      };
    }).filter((c) => c.id && c.url && c.title);
  });
}

function toDiscovered(card: NaukriCard): DiscoveredJob {
  const description = [card.snippet, card.tags.length ? `Key skills: ${card.tags.join(', ')}` : ''].filter(Boolean).join('\n');
  return {
    external_id: card.id,
    platform: 'Naukri',
    title: card.title,
    company: card.company || 'Unknown company',
    locations: card.location ? card.location.replace(/^(hybrid|remote)\s*-\s*/i, '').split(/,\s*/).filter(Boolean) : [],
    work_mode: workModeFromText(card.location),
    experience_required: card.experience || 'Not specified',
    salary: card.salary || 'Not disclosed',
    description,
    requirements: [],
    skills: Array.from(new Set([...card.tags, ...extractSkillsFromText(description)])).slice(0, 20),
    application_url: card.url,
    posted_at: relativeDateToIso(card.posted),
    is_active: true,
  };
}

/** Naukri applies with the profile resume: upload the tailored one there first. */
async function uploadResumeToProfile(ctx: ApplyContext): Promise<boolean> {
  const { page } = ctx;
  try {
    await page.goto('https://www.naukri.com/mnjuser/profile', { waitUntil: 'domcontentloaded' });
    await settle(page, 6000);
    const input = page.locator('input#attachCV, input[type="file"][id*="attach" i]').first();
    if ((await input.count()) === 0) return false;
    await input.setInputFiles(ctx.resumePath);
    const ok = await waitForAnyVisible(page, ['text=/successfully uploaded/i', '.msgBox.success', '[class*="success"]:has-text("upload")'], 15000);
    ctx.log('naukri_resume_upload', { uploaded: Boolean(ok) });
    return Boolean(ok);
  } catch (err: any) {
    ctx.log('naukri_resume_upload_failed', { error: err.message?.split('\n')[0] });
    return false;
  }
}

/** Answers Naukri's recruiter questionnaire (chat drawer shown after clicking Apply). */
async function answerChatbot(ctx: ApplyContext): Promise<ApplyResult | null> {
  const { page } = ctx;
  const drawer = '.chatbot_DrawerContentWrapper, [class*="chatbot_Drawer"], [class*="chatbot_MessageContainer"]';
  for (let round = 0; round < 20; round++) {
    await sleep(1500);
    if (!(await firstVisible(page, [drawer]))) return null;

    const question = await page.evaluate(() => {
      const msgs = Array.from(document.querySelectorAll('.botMsg, [class*="botItem"] .botMsg, li.botItem'));
      const last = msgs[msgs.length - 1] as HTMLElement | undefined;
      return (last?.innerText || '').replace(/\s+/g, ' ').trim();
    });
    if (!question) continue;

    const radios = page.locator('.ssrc__radio-btn-container, [class*="singleselect-radiobutton"] label, .chatbot_Chip, [class*="chatbot_Chip"]');
    const radioCount = await radios.count();
    const checkboxes = page.locator('.mcc__checkbox-container label, [class*="multicheckboxes"] label');
    const checkboxCount = await checkboxes.count();
    let answered = false;

    if (radioCount > 0 || checkboxCount > 0) {
      const options: string[] = [];
      const group = radioCount > 0 ? radios : checkboxes;
      const count = radioCount > 0 ? radioCount : checkboxCount;
      for (let i = 0; i < count; i++) options.push((await group.nth(i).innerText().catch(() => '')).trim());
      const result = await ctx.answerer.answer({ label: question, kind: radioCount > 0 ? 'radio' : 'checkbox-group', options, required: true });
      if (result) {
        const idx = options.findIndex((o) => o === result.answer);
        if (idx >= 0) {
          await group.nth(idx).click().catch(() => {});
          answered = true;
        }
      }
    } else {
      const input = await firstVisible(page, ['div.textArea[contenteditable="true"]', '[contenteditable="true"]', 'input#userInput', '.chatbot_InputContainer input']);
      if (input) {
        const result = await ctx.answerer.answer({ label: question, kind: 'text', required: true });
        if (result) {
          await input.click();
          await page.keyboard.insertText(result.answer);
          answered = true;
        }
      }
    }

    if (!answered) {
      ctx.answerer.markPending(question);
      return { status: 'REQUIRES_HUMAN_ACTION', message: `Naukri asked a question that needs your answer: ${question}`, unanswered: [question], screenshotPath: await ctx.screenshot('naukri_question') };
    }
    await pause(300, 700);
    await clickFirstVisible(page, ['.sendMsg', 'div.send', 'button:has-text("Save")', '[class*="sendMsg"]']);
  }
  return { status: 'REQUIRES_HUMAN_ACTION', message: 'Naukri questionnaire did not finish.', screenshotPath: await ctx.screenshot('naukri_chatbot') };
}

export const naukriAdapter: PlatformAdapter = {
  id: 'Naukri',
  name: 'Naukri',
  description: "India's largest job portal. Applies with your Naukri account.",
  requiresLogin: true,
  loginUrl: 'https://www.naukri.com/nlogin/login',
  needsVisibleBrowser: true,
  searchNeedsBrowser: true,
  notes: 'Naukri blocks hidden browsers, so a minimized Chrome window opens while it works. Naukri applies with your profile resume, so the tailored resume is uploaded to your profile before each application (can be turned off in Settings).',

  canHandleUrl(url: string) {
    return /naukri\.com\//i.test(url);
  },

  async search(ctx) {
    if (!ctx.getPage) throw new Error('Naukri search needs a browser session');
    const page = await ctx.getPage();
    const { keywords, locations, limit, postedWithinDays } = ctx.query;
    const jobAge = JOB_AGE_STEPS.find((d) => d >= postedWithinDays) || 30;
    const found = new Map<string, NaukriCard>();

    outer: for (const keyword of keywords.slice(0, 4)) {
      for (const location of (locations.length ? locations : ['']).slice(0, 3)) {
        const remote = /^remote$/i.test(location);
        const base = location && !remote ? `${slugify(keyword)}-jobs-in-${slugify(location)}` : `${slugify(keyword)}-jobs`;
        const params = new URLSearchParams({ k: keyword, jobAge: String(jobAge) });
        if (location && !remote) params.set('l', location);
        if (remote) params.set('wfhType', '2');
        await page.goto(`https://www.naukri.com/${base}?${params.toString()}`, { waitUntil: 'domcontentloaded' });
        await waitForAnyVisible(page, ['.srp-jobtuple-wrapper', '.no-result-container', 'text=/no jobs found/i'], 15000);
        const title = await page.title();
        if (/access denied/i.test(title)) {
          throw new Error('Naukri blocked the browser (Access Denied). Enable "Show browser window" or reconnect Naukri.');
        }
        for (const card of await readSearchResults(page)) {
          if (!found.has(card.id)) found.set(card.id, card);
        }
        if (found.size >= limit) break outer;
        await pause(1500, 3000);
      }
    }
    ctx.log('naukri_candidates', { found: found.size });
    return Array.from(found.values()).slice(0, limit).map(toDiscovered);
  },

  async enrich(job: NormalizedJob, getPage) {
    if (!getPage || (job.description && job.description.length > 400)) return null;
    const page = await getPage();
    await page.goto(job.application_url, { waitUntil: 'domcontentloaded' });
    await waitForAnyVisible(page, ['[class*="JDC__dang-inner-html"]', '[class*="job-desc"]', 'section[class*="job-desc"]'], 12000);
    const description = await page.evaluate(() => {
      const el = document.querySelector('[class*="JDC__dang-inner-html"], section[class*="job-desc"], [class*="job-desc-container"]') as HTMLElement | null;
      return (el?.innerText || '').trim();
    });
    if (!description) return null;
    return { description, skills: Array.from(new Set([...(job.skills || []), ...extractSkillsFromText(description)])).slice(0, 20) };
  },

  async isLoggedIn(page: Page) {
    await page.goto('https://www.naukri.com/mnjuser/homepage', { waitUntil: 'domcontentloaded' });
    await sleep(2500);
    return /mnjuser/.test(page.url()) && !/nlogin|login/.test(page.url());
  },

  async login(page, creds): Promise<LoginOutcome> {
    await page.goto('https://www.naukri.com/nlogin/login', { waitUntil: 'domcontentloaded' });
    await settle(page, 6000);
    if (/mnjuser/.test(page.url())) return { status: 'logged_in' };
    const user = await waitForAnyVisible(page, ['#usernameField', 'input[placeholder*="Email ID" i]', 'input[type="text"][name*="user" i]'], 12000);
    const pass = await firstVisible(page, ['#passwordField', 'input[type="password"]']);
    if (!user || !pass) {
      const challenge = await detectChallenge(page);
      return challenge.requiresHumanAction
        ? { status: 'challenge', reason: challenge.reason || 'Naukri security check' }
        : { status: 'failed', reason: 'Naukri login form not found (the site may have blocked the browser)' };
    }
    await user.fill(creds.username);
    await pause(300, 700);
    await pass.fill(creds.password);
    await pause(300, 700);
    await clickFirstVisible(page, ['button[type="submit"]:has-text("Login")', 'button.blue-btn', 'button[type="submit"]']);

    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      await sleep(1000);
      if (/mnjuser|naukri\.com\/?$/.test(page.url()) && !/nlogin/.test(page.url())) return { status: 'logged_in' };
      const challenge = await detectChallenge(page);
      if (challenge.requiresHumanAction) return { status: 'challenge', reason: challenge.reason || 'Naukri asked for an OTP' };
      const error = await firstVisible(page, ['.server-err', '.erLbl', '[class*="error"]:has-text("Invalid")', 'text=/invalid details|incorrect/i']);
      if (error) return { status: 'failed', reason: (await error.innerText().catch(() => 'Invalid login details')).trim() };
    }
    return { status: 'challenge', reason: 'Naukri did not finish signing in; it may be waiting for an OTP.' };
  },

  async apply(ctx) {
    const { page } = ctx;
    if (!ctx.dryRun && ctx.prefs.naukri_upload_tailored_resume !== false) {
      await uploadResumeToProfile(ctx);
    }

    await page.goto(ctx.job.application_url, { waitUntil: 'domcontentloaded' });
    await settle(page, 8000);
    if (/nlogin|login/.test(page.url())) {
      return { status: 'FAILED', message: 'Naukri session expired: reconnect Naukri on the Platforms page.' };
    }
    const challenge = await detectChallenge(page);
    if (challenge.requiresHumanAction) {
      return { status: 'REQUIRES_HUMAN_ACTION', message: challenge.reason || 'Naukri security check', screenshotPath: await ctx.screenshot('naukri_challenge') };
    }

    if (await firstVisible(page, ['#already-applied', 'button:has-text("Applied")'])) {
      return { status: 'ALREADY_APPLIED', message: 'Naukri shows this job as already applied.' };
    }

    const companySite = await firstVisible(page, ['#company-site-button', 'button:has-text("Apply on company site")']);
    const applyButton = await firstVisible(page, ['#apply-button', 'button.apply-button:has-text("Apply")', 'button:text-is("Apply")']);
    if (!applyButton) {
      if (companySite) {
        const popupPromise = ctx.context.waitForEvent('page', { timeout: 10000 }).catch(() => null);
        await companySite.click().catch(() => {});
        const popup = await popupPromise;
        const externalUrl = popup ? popup.url() : page.url();
        await popup?.close().catch(() => {});
        return { status: 'EXTERNAL', message: 'This Naukri job applies on the company website.', externalUrl };
      }
      return { status: 'FAILED', message: 'Apply button not found on the Naukri job page.', screenshotPath: await ctx.screenshot('naukri_no_apply') };
    }

    if (ctx.dryRun) {
      // On Naukri a single click submits the application, so dry-run stops here
      return { status: 'DRY_RUN_READY', message: 'Dry run: Naukri job is ready; clicking Apply would submit with your profile resume.', screenshotPath: await ctx.screenshot('naukri_dry_run') };
    }

    await applyButton.click();
    await sleep(2500);
    const chatResult = await answerChatbot(ctx);
    if (chatResult) return chatResult;

    const verdict = await verifySubmission(page, {
      successText: /applied (successfully|to)|you have successfully applied|application sent|successfully applied/i,
      successSelectors: ['#already-applied', '.apply-message', '[class*="applied"]'],
      successUrl: /saveApply|myapply/i,
      timeoutMs: 15000,
    });
    const shot = await ctx.screenshot(verdict.outcome === 'success' ? 'naukri_applied' : 'naukri_after_apply');
    if (verdict.outcome === 'success') {
      return { status: 'SUBMITTED', verified: true, message: 'Naukri confirmed the application.', screenshotPath: shot };
    }
    const text = await bodyText(page, 3000);
    return {
      status: 'REQUIRES_HUMAN_ACTION',
      message: verdict.outcome === 'unknown' ? `Clicked Apply but Naukri showed no confirmation. ${text.slice(0, 120)}` : verdict.message,
      screenshotPath: shot,
    };
  },
};
