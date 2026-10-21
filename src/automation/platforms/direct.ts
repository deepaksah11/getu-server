import { scanFields } from '../engine/fieldScanner.js';
import { bodyText, firstVisible, settle, sleep } from '../engine/pageUtils.js';
import { ashbyAdapter } from './ashby.js';
import { greenhouseAdapter } from './greenhouse.js';
import { leverAdapter } from './lever.js';
import { applySinglePageForm } from './singlePageForm.js';
import { ApplyContext, ApplyResult, PlatformAdapter } from './types.js';

const ATS_ADAPTERS = [greenhouseAdapter, leverAdapter, ashbyAdapter];

/** Applicant tracking systems that always require creating an account first. */
const ACCOUNT_WALLED = /myworkdayjobs\.com|workday\.com\/.*\/job|taleo\.net|successfactors\.|icims\.com|brassring\.com|oraclecloud\.com\/hcmUI|smartrecruiters\.com\/.*\/apply|jobvite\.com\/.*\/apply/i;

async function delegateToAts(ctx: ApplyContext, url: string): Promise<ApplyResult | null> {
  const ats = ATS_ADAPTERS.find((a) => a.canHandleUrl(url));
  if (!ats) return null;
  ctx.log('external_ats_detected', { platform: ats.id, url });
  return ats.apply({ ...ctx, job: { ...ctx.job, application_url: url } });
}

export const directAdapter: PlatformAdapter = {
  id: 'Direct Portals',
  name: 'Company career sites',
  description: 'Jobs you add by URL and "apply on company site" links from other platforms. Fills simple application forms.',
  requiresLogin: false,
  notes: 'Best effort: career sites that need an account (Workday, Taleo, iCIMS...) are handed to you with the tailored resume ready.',

  canHandleUrl() {
    return true;
  },

  async search() {
    return [];
  },

  async apply(ctx) {
    const { page } = ctx;
    const startUrl = ctx.job.application_url;
    const direct = await delegateToAts(ctx, startUrl);
    if (direct) return direct;
    if (ACCOUNT_WALLED.test(startUrl)) {
      return { status: 'REQUIRES_HUMAN_ACTION', message: 'This company site requires creating an account. Apply manually with the tailored resume.' };
    }

    await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
    await settle(page, 8000);
    const redirected = await delegateToAts(ctx, page.url());
    if (redirected) return redirected;
    if (ACCOUNT_WALLED.test(page.url())) {
      return { status: 'REQUIRES_HUMAN_ACTION', message: 'This company site requires creating an account. Apply manually with the tailored resume.' };
    }

    let fields = (await scanFields(page, null)).filter((f) => f.kind !== 'file' || f.isResume);
    if (fields.length < 2) {
      // Job description page: follow its Apply link
      const applyLink = await firstVisible(page, ['a:has-text("Apply now")', 'button:has-text("Apply now")', 'a:has-text("Apply for this job")', 'a:has-text("Apply")', 'button:has-text("Apply")']);
      if (applyLink) {
        const popupPromise = ctx.context.waitForEvent('page', { timeout: 6000 }).catch(() => null);
        await applyLink.click().catch(() => {});
        const popup = await popupPromise;
        const target = popup || page;
        await settle(target, 8000);
        const viaPopup = await delegateToAts({ ...ctx, page: target }, target.url());
        if (viaPopup) return viaPopup;
        if (popup) {
          return directAdapter.apply({ ...ctx, page: popup, job: { ...ctx.job, application_url: popup.url() } });
        }
        await sleep(1000);
        fields = (await scanFields(page, null)).filter((f) => f.kind !== 'file' || f.isResume);
      }
    }

    const text = await bodyText(page, 6000);
    const hasPassword = (await page.locator('input[type="password"]:visible').count().catch(() => 0)) > 0;
    if (hasPassword || /create (an |your )?account|sign in to apply|log ?in to apply|register to apply/i.test(text)) {
      return { status: 'REQUIRES_HUMAN_ACTION', message: 'The company site asks you to sign in or create an account before applying.', screenshotPath: await ctx.screenshot('account_wall') };
    }
    if (fields.length === 0) {
      return { status: 'REQUIRES_HUMAN_ACTION', message: 'No application form found on the company site; apply manually with the tailored resume.', screenshotPath: await ctx.screenshot('no_form') };
    }

    return applySinglePageForm(ctx, {
      formScope: ['form:has(input[type="email"])', 'form:has(input[type="file"])'],
      submitButtons: ['button[type="submit"]', 'input[type="submit"]', 'button:has-text("Submit")', 'button:has-text("Send application")'],
      verify: { timeoutMs: 15000 },
    });
  },
};
