import { Page } from 'playwright';
import { ApplyContext, ApplyResult } from '../platforms/types.js';
import { detectChallenge } from './challengeDetector.js';
import { fillForm } from './formFiller.js';
import { firstVisible, pause, sleep } from './pageUtils.js';
import { verifySubmission, VerifyOptions } from './submissionVerifier.js';

export interface MultiStepOptions {
  /** Container of the application flow (modal); null = whole page */
  scope: string | null;
  submitButtons: string[];
  reviewButtons?: string[];
  nextButtons: string[];
  errorSelectors?: string[];
  maxSteps?: number;
  /** Runs before the final submit click (e.g. untick "follow company") */
  beforeSubmit?: (page: Page) => Promise<void>;
  verify: VerifyOptions;
  overwrite?: boolean;
}

/**
 * Drives a multi-page application (LinkedIn Easy Apply, Indeed, Unstop...):
 * fill the visible step, press Next/Review, repeat until the submit button.
 * In dry-run mode it stops at the submit button without clicking it.
 */
export async function runMultiStep(ctx: ApplyContext, opts: MultiStepOptions): Promise<ApplyResult> {
  const { page } = ctx;
  const maxSteps = opts.maxSteps ?? 12;
  let lastSignature = '';
  let repeats = 0;
  const filledLabels: { label: string; value: string }[] = [];

  for (let step = 0; step < maxSteps; step++) {
    const challenge = await detectChallenge(page);
    if (challenge.requiresHumanAction) {
      return { status: 'REQUIRES_HUMAN_ACTION', message: challenge.reason || 'Human verification required', filled: filledLabels };
    }

    const report = await fillForm(page, opts.scope, {
      answerer: ctx.answerer,
      resumePath: ctx.resumePath,
      coverLetterPath: ctx.coverLetterPath,
      overwrite: opts.overwrite,
    });
    for (const f of report.filled) filledLabels.push({ label: f.label, value: f.value });
    ctx.log('form_step', { step: step + 1, filled: report.filled.length, prefilled: report.prefilled.length, unanswered: report.unanswered });
    await pause(400, 900);

    const scope = opts.scope ? page.locator(opts.scope).first() : page;
    const submit = await firstVisible(scope, opts.submitButtons);
    if (submit) {
      if (report.unanswered.length > 0) {
        for (const q of report.unanswered) ctx.answerer.markPending(q);
        return {
          status: 'REQUIRES_HUMAN_ACTION',
          message: `Needs your answer to: ${report.unanswered.join('; ')}`,
          unanswered: report.unanswered,
          filled: filledLabels,
        };
      }
      if (ctx.dryRun) {
        const shot = await ctx.screenshot('dry_run_review');
        return {
          status: 'DRY_RUN_READY',
          message: 'Dry run: every step was filled and the resume attached. Stopped before the final submit.',
          screenshotPath: shot,
          filled: filledLabels,
        };
      }
      if (opts.beforeSubmit) await opts.beforeSubmit(page).catch(() => {});
      await submit.click({ timeout: 10000 });
      const verdict = await verifySubmission(page, opts.verify);
      const shot = await ctx.screenshot(verdict.outcome === 'success' ? 'submitted' : 'after_submit');
      if (verdict.outcome === 'success') {
        return { status: 'SUBMITTED', verified: true, message: verdict.message, confirmationNumber: verdict.confirmationNumber, screenshotPath: shot, filled: filledLabels };
      }
      if (verdict.outcome === 'error') {
        for (const e of verdict.errors || []) ctx.answerer.markPending(e);
      }
      return {
        status: 'REQUIRES_HUMAN_ACTION',
        message: verdict.outcome === 'unknown' ? 'Submitted, but the platform showed no confirmation. Please check your applications on the platform.' : verdict.message,
        screenshotPath: shot,
        unanswered: verdict.errors,
        filled: filledLabels,
      };
    }

    const advance = (opts.reviewButtons && (await firstVisible(scope, opts.reviewButtons))) || (await firstVisible(scope, opts.nextButtons));
    if (!advance) {
      // The flow may have finished on its own (some platforms submit on the last "Next")
      const verdict = await verifySubmission(page, { ...opts.verify, timeoutMs: 3000 });
      if (verdict.outcome === 'success' && !ctx.dryRun) {
        return { status: 'SUBMITTED', verified: true, message: verdict.message, filled: filledLabels };
      }
      const shot = await ctx.screenshot('no_next_button');
      return { status: 'FAILED', message: 'Could not find the next or submit button in the application form.', screenshotPath: shot, filled: filledLabels };
    }

    const signature = `${report.fieldCount}|${report.unanswered.join(',')}|${(await advance.innerText().catch(() => '')).trim()}`;
    await advance.click({ timeout: 10000 });
    await sleep(1200);

    const errors = await page
      .locator((opts.errorSelectors || ['.artdeco-inline-feedback--error', '[aria-invalid="true"]', '[class*="error" i][role="alert"]']).join(', '))
      .filter({ hasText: /\S/ })
      .count()
      .catch(() => 0);
    if (errors > 0 || signature === lastSignature) {
      repeats = signature === lastSignature ? repeats + 1 : 1;
      if (repeats >= 2) {
        const pending = report.unanswered.length ? report.unanswered : ['A required question on this step'];
        for (const q of pending) ctx.answerer.markPending(q);
        const shot = await ctx.screenshot('stuck_on_step');
        return {
          status: 'REQUIRES_HUMAN_ACTION',
          message: `The form did not accept step ${step + 1}. Needs your answer to: ${pending.join('; ')}`,
          unanswered: report.unanswered,
          screenshotPath: shot,
          filled: filledLabels,
        };
      }
    } else {
      repeats = 0;
    }
    lastSignature = signature;
  }

  const shot = await ctx.screenshot('too_many_steps');
  return { status: 'FAILED', message: `Application had more than ${maxSteps} steps; stopped for safety.`, screenshotPath: shot, filled: filledLabels };
}
