import { detectChallenge } from '../engine/challengeDetector.js';
import { fillForm } from '../engine/formFiller.js';
import { clickFirstVisible, firstVisible, pause, settle, sleep } from '../engine/pageUtils.js';
import { verifySubmission, VerifyOptions } from '../engine/submissionVerifier.js';
import { ApplyContext, ApplyResult } from './types.js';

export interface SinglePageOptions {
  /** Selectors of the application form in priority order; null scans the whole page */
  formScope: string[] | null;
  /** Buttons that reveal the form ("Apply for this job") */
  openFormButtons?: string[];
  submitButtons: string[];
  verify: VerifyOptions;
  overwrite?: boolean;
  /** Platform-specific touch-ups after the generic fill (e.g. location autocomplete) */
  afterFill?: (ctx: ApplyContext) => Promise<void>;
}

/**
 * Returns a selector for the first visible element matching the candidates in
 * priority order (a comma-separated list would match in document order instead).
 */
async function resolveScope(page: ApplyContext['page'], candidates: string[] | null): Promise<string | null> {
  if (!candidates?.length) return null;
  for (const selector of candidates) {
    const match = await firstVisible(page, [selector]);
    if (match) {
      const token = `scope-${Date.now()}`;
      await match.evaluate((el, t) => el.setAttribute('data-aa-scope', t), token);
      return `[data-aa-scope="${token}"]`;
    }
  }
  return null;
}

/**
 * Fills a one-page application form (ATS boards, company career sites) and
 * submits it, or stops before submitting in dry-run mode.
 */
export async function applySinglePageForm(ctx: ApplyContext, opts: SinglePageOptions): Promise<ApplyResult> {
  const { page } = ctx;
  await settle(page, 8000);

  let challenge = await detectChallenge(page);
  if (challenge.requiresHumanAction) {
    return { status: 'REQUIRES_HUMAN_ACTION', message: challenge.reason || 'Human verification required', screenshotPath: await ctx.screenshot('challenge') };
  }

  let scope = await resolveScope(page, opts.formScope);
  if (opts.formScope && !scope && opts.openFormButtons?.length && (await clickFirstVisible(page, opts.openFormButtons))) {
    await settle(page, 6000);
    await sleep(1000);
    scope = await resolveScope(page, opts.formScope);
  }

  const fillCtx = {
    answerer: ctx.answerer,
    resumePath: ctx.resumePath,
    coverLetterPath: ctx.coverLetterPath,
    overwrite: opts.overwrite ?? true,
  };
  // Two passes: answering a question can reveal follow-up questions
  const first = await fillForm(page, scope, fillCtx);
  await pause(500, 1000);
  const second = await fillForm(page, scope, fillCtx);
  if (opts.afterFill) await opts.afterFill(ctx);

  const filled = [...first.filled, ...second.filled].map((f) => ({ label: f.label, value: f.value }));
  ctx.log('form_filled', {
    filled: filled.length,
    prefilled: second.prefilled.length,
    resumeUploaded: first.resumeUploaded || second.resumeUploaded,
  });

  if (first.fieldCount + second.fieldCount === 0 && !first.resumeUploaded) {
    return { status: 'FAILED', message: 'No application form was found on the page.', screenshotPath: await ctx.screenshot('no_form') };
  }

  const unanswered = Array.from(new Set(second.unanswered));
  if (unanswered.length > 0) {
    for (const q of unanswered) ctx.answerer.markPending(q);
    return {
      status: 'REQUIRES_HUMAN_ACTION',
      message: `Needs your answer to: ${unanswered.join('; ')}`,
      unanswered,
      filled,
      screenshotPath: await ctx.screenshot('unanswered'),
    };
  }

  const submit = await firstVisible(page, opts.submitButtons);
  if (!submit) {
    return { status: 'FAILED', message: 'The submit button was not found on the application form.', filled, screenshotPath: await ctx.screenshot('no_submit') };
  }

  if (ctx.dryRun) {
    await submit.scrollIntoViewIfNeeded().catch(() => {});
    return {
      status: 'DRY_RUN_READY',
      message: 'Dry run: the form was filled and the tailored resume attached. Not submitted.',
      filled,
      screenshotPath: await ctx.screenshot('dry_run'),
    };
  }

  challenge = await detectChallenge(page);
  if (challenge.requiresHumanAction) {
    return { status: 'REQUIRES_HUMAN_ACTION', message: challenge.reason || 'Human verification required', filled, screenshotPath: await ctx.screenshot('challenge') };
  }

  await submit.scrollIntoViewIfNeeded().catch(() => {});
  await submit.click({ timeout: 10000 });
  const verdict = await verifySubmission(page, opts.verify);
  const shot = await ctx.screenshot(verdict.outcome === 'success' ? 'submitted' : 'after_submit');

  if (verdict.outcome === 'success') {
    return { status: 'SUBMITTED', verified: true, message: verdict.message, confirmationNumber: verdict.confirmationNumber, filled, screenshotPath: shot };
  }
  if (verdict.outcome === 'error') {
    for (const e of verdict.errors || []) ctx.answerer.markPending(e);
  }
  return {
    status: 'REQUIRES_HUMAN_ACTION',
    message:
      verdict.outcome === 'unknown'
        ? 'Submit was clicked but no confirmation appeared. Please check your email or the company site.'
        : verdict.message,
    unanswered: verdict.errors,
    filled,
    screenshotPath: shot,
  };
}
