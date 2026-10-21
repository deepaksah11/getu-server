import path from 'path';
import { Page } from 'playwright';
import { v4 as uuidv4 } from 'uuid';
import { getRepository } from '../db/client.js';
import { logger } from '../config/logger.js';
import { Application, ApplicationQuestion, ApplicationStatus, NormalizedJob } from '../types/index.js';
import { aiService } from '../ai/aiService.js';
import { FieldKind } from '../ai/answerRules.js';
import { matchingEngine } from '../matching/matchingEngine.js';
import { eligibilityChecker } from '../matching/eligibilityChecker.js';
import { tailoringEngine } from '../resumes/tailoringEngine.js';
import { generateCoverLetterPDF } from '../resumes/pdfGenerator.js';
import { ApplicationStateMachine } from '../queue/stateMachine.js';
import { connectionManager, PlatformSession } from './connectionManager.js';
import { FormAnswerer } from './engine/answerEngine.js';
import { takeScreenshot } from './engine/pageUtils.js';
import { adapterForJob, adapterForUrl } from './platforms/registry.js';
import { ApplyContext, ApplyResult } from './platforms/types.js';
import { profileReadiness } from './readiness.js';

export interface ProcessJobOptions {
  runId?: string;
  /** Overrides the user's automation mode */
  dryRun?: boolean;
  /** Manual apply from the UI: the score threshold, daily quota and platform selection do not block it */
  manual?: boolean;
  /** Browser session shared by an automation run */
  session?: PlatformSession;
}

export interface ProcessJobResult {
  success: boolean;
  status: ApplicationStatus;
  message: string;
  applicationId?: string;
  /** The platform session is no longer valid; the run should stop using this platform */
  sessionExpired?: boolean;
}

const QUESTION_TYPE: Partial<Record<FieldKind, ApplicationQuestion['question_type']>> = {
  number: 'experience',
  radio: 'yes_no',
  checkbox: 'yes_no',
  textarea: 'motivation',
};

async function countSubmittedToday(userId: string, platform?: string): Promise<number> {
  const today = new Date().toISOString().split('T')[0];
  const { applications } = await getRepository().getApplications(userId, { status: 'SUBMITTED', limit: 5000 });
  return applications.filter((a) => (a.applied_at || '').startsWith(today) && (!platform || a.platform === platform)).length;
}

export { countSubmittedToday };

export class AutomationWorker {
  private locks = new Set<string>();

  public async processJob(userId: string, inputJob: NormalizedJob, options: ProcessJobOptions = {}): Promise<ProcessJobResult> {
    const repo = getRepository();
    const runId = options.runId || uuidv4();
    const lockKey = `${userId}:${inputJob.id}`;
    if (this.locks.has(lockKey)) {
      return { success: false, status: 'DUPLICATE', message: 'This job is already being processed' };
    }
    this.locks.add(lockKey);

    const started = Date.now();
    let job = inputJob;
    let application: Application | null = null;
    let ownSession: PlatformSession | null = null;
    let page: Page | null = null;

    const step = (name: string, status: 'success' | 'warning' | 'failed' | 'paused', details: Record<string, any> = {}) =>
      repo
        .addStep({ run_id: runId, job_id: job.id, application_id: application?.id, step_name: name, status, details, duration_ms: Date.now() - started })
        .catch(() => undefined);

    try {
      const profile = await repo.getProfile(userId);
      const readiness = profileReadiness(profile);
      if (!readiness.ready) {
        return { success: false, status: 'FAILED', message: `Complete your profile first: ${readiness.missing.join(', ')}` };
      }

      application = await repo.getApplicationByJob(userId, job.id);
      if (application && (application.status === 'SUBMITTED' || application.status === 'DUPLICATE')) {
        return { success: true, status: application.status, message: 'Already applied to this job', applicationId: application.id };
      }
      if (!application) {
        application = await repo.createApplication({ user_id: userId, job_id: job.id, platform: job.platform, status: 'DISCOVERED', attempt_count: 0 });
      }
      await repo.updateApplication(application.id, {
        attempt_count: (application.attempt_count || 0) + 1,
        failure_reason: undefined,
        requires_human_reason: undefined,
        unanswered_questions: [],
      });
      await ApplicationStateMachine.transition(application.id, 'ANALYZING');

      const [master, prefs] = await Promise.all([repo.getMasterResume(userId), repo.getPreferences(userId)]);
      const adapter = adapterForJob(job);
      const dryRun = options.dryRun ?? prefs.automation_mode === 'dry-run';
      const mode = connectionManager.browserModeFor(adapter, prefs.show_browser);
      const getSession = async (): Promise<PlatformSession> => {
        if (options.session) return options.session;
        if (!ownSession) ownSession = await connectionManager.openSession(userId, adapter.id, mode);
        return ownSession;
      };

      // 1. Full job description for analysis and tailoring
      if (adapter.enrich && (!job.description || job.description.length < 400)) {
        try {
          const extra = await adapter.enrich(job, async () => (await getSession()).page);
          if (extra) {
            job = await repo.upsertJob({
              ...job,
              ...extra,
              extracted_metadata: { ...(job.extracted_metadata || {}), ...(extra.extracted_metadata || {}) },
            });
          }
        } catch (err: any) {
          await step('job_enrichment', 'warning', { error: err.message?.split('\n')[0] });
        }
      }

      // 2. Requirements analysis (Gemini when configured, offline engine otherwise)
      const analysis = await aiService.analyzeJobDescription(job);
      if (job.skills.length === 0 && analysis.required_skills.length > 0) {
        job = await repo.upsertJob({ ...job, skills: analysis.required_skills.slice(0, 20) });
      }
      await step('jd_analysis', 'success', {
        jobTitle: job.title,
        company: job.company,
        requiredSkills: analysis.required_skills.slice(0, 12),
        engine: aiService.hasProvider() ? 'ai' : 'offline',
      });

      // 3. Match and eligibility
      const roles = [...(prefs.preferred_roles || []), ...(prefs.search_keywords || [])];
      const matchData = matchingEngine.calculateMatch(profile, job, roles);
      const submittedToday = await countSubmittedToday(userId);
      const eligibility = eligibilityChecker.checkEligibility(matchData, job, prefs, submittedToday);
      const overridable = /match score|Daily application limit|enabled platforms/i.test(eligibility.reason || '');
      const eligible = eligibility.is_eligible || (options.manual === true && overridable);
      await repo.saveMatch({ ...matchData, is_eligible: eligible, eligibility_reason: eligibility.reason });
      if (!eligible) {
        await ApplicationStateMachine.transition(application.id, 'NOT_ELIGIBLE', eligibility.reason);
        await step('eligibility_check', 'warning', { reason: eligibility.reason, score: matchData.overall_match_score });
        return { success: false, status: 'NOT_ELIGIBLE', message: eligibility.reason || 'Not eligible', applicationId: application.id };
      }
      await ApplicationStateMachine.transition(application.id, 'MATCHED');
      await step('matching', 'success', {
        score: matchData.overall_match_score,
        matchedSkills: matchData.matched_skills.slice(0, 12),
        missingSkills: matchData.missing_skills.slice(0, 8),
      });

      // 4. Job-specific resume and cover letter
      await ApplicationStateMachine.transition(application.id, 'RESUME_GENERATING');
      const resume = await tailoringEngine.generateTailoredResume(profile, master, job, 'ats_classic', analysis);
      if (!resume.pdf_path) throw new Error('The tailored resume PDF could not be generated');
      await repo.updateApplication(application.id, { resume_version_id: resume.id });
      await ApplicationStateMachine.transition(application.id, 'RESUME_READY');
      let coverLetterPath: string | undefined;
      if (resume.cover_letter) {
        coverLetterPath = await generateCoverLetterPDF(profile, resume.cover_letter, resume.pdf_path.replace(/\.pdf$/i, '_cover_letter.pdf')).catch(() => undefined);
      }
      await step('resume_generation', 'success', {
        atsScore: resume.ats_score,
        pdf: path.basename(resume.pdf_path),
        coverLetter: Boolean(resume.cover_letter),
      });
      await ApplicationStateMachine.transition(application.id, 'APPLICATION_READY');

      // 5. Platform session (saved login, re-login with the stored password when expired)
      const session = await getSession();
      if (!session.ok) {
        await ApplicationStateMachine.transition(application.id, 'REQUIRES_HUMAN_ACTION', session.reason);
        await step('platform_login', 'paused', { platform: adapter.id, reason: session.reason });
        return { success: false, status: 'REQUIRES_HUMAN_ACTION', message: session.reason || 'Login required', applicationId: application.id, sessionExpired: true };
      }

      // 6. Apply
      await ApplicationStateMachine.transition(application.id, 'APPLYING');
      const answerer = await FormAnswerer.create(userId, profile, job, resume.cover_letter);
      page = await session.context.newPage();
      const appId = application.id;
      const ctx: ApplyContext = {
        page,
        context: session.context,
        job,
        profile,
        prefs,
        resumePath: resume.pdf_path,
        coverLetter: resume.cover_letter,
        coverLetterPath,
        dryRun,
        answerer,
        log: (name, details) => void step(name, 'success', details || {}),
        screenshot: async (label) => {
          const pages = session.context.pages().filter((p) => !p.isClosed());
          return takeScreenshot(pages[pages.length - 1] || page!, `${appId}_${label}`);
        },
      };
      logger.info({ jobId: job.id, platform: adapter.id, dryRun }, 'Applying to job');

      let result: ApplyResult = await adapter.apply(ctx);
      if (result.status === 'EXTERNAL' && result.externalUrl) {
        const external = adapterForUrl(result.externalUrl);
        await step('external_application', 'success', { url: result.externalUrl, handler: external.id });
        result = await external.apply({ ...ctx, job: { ...job, application_url: result.externalUrl } });
        if (result.status === 'EXTERNAL') {
          result = { status: 'REQUIRES_HUMAN_ACTION', message: `Apply on the company site: ${result.externalUrl}`, externalUrl: result.externalUrl };
        }
      }

      await this.saveAnswers(application.id, answerer);
      await answerer.persistPending();
      if (!options.session) await session.save();
      return await this.recordResult(application.id, runId, job, result, step);
    } catch (err: any) {
      const message = (err.message || 'Unknown error').split('\n')[0];
      logger.error({ err: message, jobId: job.id }, 'Automation worker error');
      if (application) {
        await ApplicationStateMachine.transition(application.id, 'FAILED', message).catch(() => {});
        await repo
          .addError({ run_id: runId, application_id: application.id, error_type: 'WORKER_EXECUTION_FAILURE', message, stack: err.stack, resolved: false })
          .catch(() => {});
      }
      return { success: false, status: 'FAILED', message, applicationId: application?.id };
    } finally {
      if (page) await page.close().catch(() => {});
      const own = ownSession as PlatformSession | null;
      if (own) await own.close().catch(() => {});
      this.locks.delete(lockKey);
    }
  }

  private async saveAnswers(applicationId: string, answerer: FormAnswerer): Promise<void> {
    const repo = getRepository();
    const existing = new Set((await repo.getQuestions(applicationId)).map((q) => q.question_text));
    for (const given of answerer.given) {
      if (existing.has(given.question)) continue;
      existing.add(given.question);
      const q = await repo.saveQuestion({
        application_id: applicationId,
        question_text: given.question,
        question_type: QUESTION_TYPE[given.kind] || 'general',
        is_required: true,
      });
      await repo.saveAnswer({
        question_id: q.id,
        answer_text: given.answer,
        source: given.source,
        is_factual: given.source !== 'ai',
      });
    }
  }

  private async recordResult(
    applicationId: string,
    runId: string,
    job: NormalizedJob,
    result: ApplyResult,
    step: (name: string, status: 'success' | 'warning' | 'failed' | 'paused', details?: Record<string, any>) => Promise<unknown>
  ): Promise<ProcessJobResult> {
    const repo = getRepository();
    const now = new Date().toISOString();
    switch (result.status) {
      case 'SUBMITTED':
        await ApplicationStateMachine.transition(applicationId, 'SUBMITTED');
        await repo.updateApplication(applicationId, {
          submission_verified: result.verified === true,
          screenshot_path: result.screenshotPath,
          submission_receipt: {
            confirmation_number: result.confirmationNumber,
            timestamp: now,
            message: result.message,
            screenshot_path: result.screenshotPath,
          },
        });
        await step('submission', 'success', { verified: result.verified === true, confirmation: result.confirmationNumber, fields: result.filled?.length });
        return { success: true, status: 'SUBMITTED', message: result.message, applicationId };

      case 'DRY_RUN_READY':
        await ApplicationStateMachine.transition(applicationId, 'APPLICATION_READY');
        await repo.updateApplication(applicationId, {
          screenshot_path: result.screenshotPath,
          submission_receipt: { timestamp: now, message: result.message, screenshot_path: result.screenshotPath },
        });
        await step('dry_run_form_fill', 'success', { fieldsFilled: result.filled?.length || 0, screenshot: result.screenshotPath });
        return { success: true, status: 'APPLICATION_READY', message: result.message, applicationId };

      case 'ALREADY_APPLIED':
        await ApplicationStateMachine.transition(applicationId, 'DUPLICATE');
        await repo.updateApplication(applicationId, { failure_reason: result.message });
        await step('duplicate_check', 'warning', { message: result.message });
        return { success: true, status: 'DUPLICATE', message: result.message, applicationId };

      case 'REQUIRES_HUMAN_ACTION':
      case 'EXTERNAL':
        await ApplicationStateMachine.transition(applicationId, 'REQUIRES_HUMAN_ACTION', result.message);
        await repo.updateApplication(applicationId, {
          screenshot_path: result.screenshotPath,
          unanswered_questions: result.unanswered || [],
        });
        await repo.addError({ run_id: runId, application_id: applicationId, error_type: 'HUMAN_ACTION_REQUIRED', message: result.message, resolved: false });
        await step('human_action', 'paused', { reason: result.message, unanswered: result.unanswered, externalUrl: result.externalUrl });
        return { success: false, status: 'REQUIRES_HUMAN_ACTION', message: result.message, applicationId };

      case 'FAILED':
      default: {
        await ApplicationStateMachine.transition(applicationId, 'FAILED', result.message);
        await repo.updateApplication(applicationId, { screenshot_path: result.screenshotPath });
        await repo.addError({ run_id: runId, application_id: applicationId, error_type: 'APPLY_FAILED', message: result.message, context: { platform: job.platform }, resolved: false });
        await step('submission', 'failed', { reason: result.message });
        return {
          success: false,
          status: 'FAILED',
          message: result.message,
          applicationId,
          sessionExpired: /session expired/i.test(result.message),
        };
      }
    }
  }
}

export const automationWorker = new AutomationWorker();
