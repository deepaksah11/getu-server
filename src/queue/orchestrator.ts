import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { getRepository } from '../db/client.js';
import { AutomationRun, AutomationRunProgress, NormalizedJob, PlatformRunSummary } from '../types/index.js';
import { matchingEngine } from '../matching/matchingEngine.js';
import { connectionManager, PlatformSession } from '../automation/connectionManager.js';
import { sleep } from '../automation/engine/pageUtils.js';
import { getAdapter } from '../automation/platforms/registry.js';
import { PlatformAdapter } from '../automation/platforms/types.js';
import { buildSearchQuery, profileReadiness } from '../automation/readiness.js';
import { sessionStore } from '../automation/security/sessionStore.js';
import { automationWorker, countSubmittedToday } from '../automation/worker.js';
import { normalizeQuestion } from '../ai/answerRules.js';
import { titleMatchesAny } from '../automation/platforms/shared.js';

export interface StartOptions {
  trigger?: AutomationRun['trigger_type'];
  /** Restrict this run to some platforms (defaults to the user's enabled platforms) */
  platforms?: string[];
  dryRun?: boolean;
}

interface RunState {
  runId: string;
  cancelled: boolean;
  done: Promise<void>;
}

const RETRYABLE_ATTEMPTS = 3;

export class AutomationOrchestrator {
  private runs = new Map<string, RunState>();

  isRunning(userId: string): boolean {
    return this.runs.has(userId);
  }

  activeRunId(userId: string): string | undefined {
    return this.runs.get(userId)?.runId;
  }

  /** Resolves when the user's current run has finished (used by tests and shutdown). */
  async waitForRun(userId: string): Promise<void> {
    await this.runs.get(userId)?.done;
  }

  stop(userId: string): boolean {
    const state = this.runs.get(userId);
    if (!state) return false;
    state.cancelled = true;
    return true;
  }

  async stopAll(): Promise<void> {
    for (const state of this.runs.values()) state.cancelled = true;
    await Promise.all(Array.from(this.runs.values()).map((s) => s.done.catch(() => {})));
  }

  /**
   * Starts a full automation run in the background and returns its id:
   * discover jobs on every selected platform, then tailor and apply.
   */
  async start(userId: string, options: StartOptions = {}): Promise<{ runId: string }> {
    if (this.runs.has(userId)) {
      throw new Error('An automation run is already in progress');
    }
    const repo = getRepository();
    const [profile, prefs] = await Promise.all([repo.getProfile(userId), repo.getPreferences(userId)]);
    const dryRun = options.dryRun ?? prefs.automation_mode === 'dry-run';
    const readiness = profileReadiness(profile);
    const platformIds = (options.platforms?.length ? options.platforms : prefs.enabled_platforms || [])
      .map((p) => getAdapter(p)?.id)
      .filter((p): p is string => Boolean(p));

    await repo.updatePreferences(userId, { last_run_at: new Date().toISOString() });

    const baseRun = {
      user_id: userId,
      trigger_type: options.trigger || 'manual',
      mode: dryRun ? 'dry-run' : 'production',
      jobs_scanned: 0,
      jobs_matched: 0,
      applications_submitted: 0,
      applications_failed: 0,
      human_verification_required: 0,
    } as const;

    const problem = !readiness.ready
      ? `Complete your profile first: ${readiness.missing.join(', ')}`
      : platformIds.length === 0
        ? 'Select at least one platform on the Platforms page.'
        : null;
    if (problem) {
      const failed = await repo.createRun({ ...baseRun, status: 'failed', progress: { phase: 'finished', message: problem } });
      await repo.updateRun(failed.id, { ended_at: new Date().toISOString(), error_message: problem });
      throw new Error(problem);
    }

    const run = await repo.createRun({ ...baseRun, status: 'running', progress: { phase: 'starting' } });
    const state: RunState = { runId: run.id, cancelled: false, done: Promise.resolve() };
    state.done = this.execute(userId, run, platformIds, dryRun, state)
      .catch(async (err) => {
        logger.error({ err: err.message, userId }, 'Automation run crashed');
        await repo.updateRun(run.id, { status: 'failed', ended_at: new Date().toISOString(), error_message: err.message }).catch(() => {});
      })
      .finally(() => this.runs.delete(userId));
    this.runs.set(userId, state);
    return { runId: run.id };
  }

  private async execute(userId: string, run: AutomationRun, platformIds: string[], dryRun: boolean, state: RunState): Promise<void> {
    const repo = getRepository();
    const profile = await repo.getProfile(userId);
    const prefs = await repo.getPreferences(userId);
    const query = buildSearchQuery(prefs, profile);
    const roles = [...(prefs.preferred_roles || []), ...query.keywords];

    const totals = { scanned: 0, matched: 0, submitted: 0, failed: 0, human: 0 };
    const platforms: Record<string, PlatformRunSummary> = {};
    let remainingToday = Math.max(0, prefs.max_applications_per_day - (await countSubmittedToday(userId)));

    const progress = async (p: AutomationRunProgress) => {
      await repo.updateRun(run.id, {
        progress: p,
        platforms,
        jobs_scanned: totals.scanned,
        jobs_matched: totals.matched,
        applications_submitted: totals.submitted,
        applications_failed: totals.failed,
        human_verification_required: totals.human,
      });
    };
    const runStep = (name: string, status: 'success' | 'warning' | 'failed' | 'paused', details: Record<string, any>) =>
      repo.addStep({ run_id: run.id, step_name: name, status, details, duration_ms: 0 }).catch(() => undefined);

    await runStep('run_started', 'success', { mode: dryRun ? 'dry-run' : 'production', platforms: platformIds, keywords: query.keywords, locations: query.locations });

    for (const platformId of platformIds) {
      if (state.cancelled) break;
      if (!dryRun && remainingToday <= 0) {
        await runStep('daily_limit_reached', 'warning', { limit: prefs.max_applications_per_day });
        break;
      }
      const adapter = getAdapter(platformId)!;
      const summary: PlatformRunSummary = { discovered: 0, applied: 0, failed: 0, needs_action: 0 };
      platforms[adapter.id] = summary;
      await progress({ phase: 'discovering', platform: adapter.id, message: `Searching ${adapter.name}` });

      let session: PlatformSession | null = null;
      try {
        const skip = await this.loginProblem(userId, adapter);
        if (skip) {
          summary.skipped_reason = skip;
          await runStep('platform_skipped', 'warning', { platform: adapter.id, reason: skip });
          continue;
        }
        if (adapter.requiresLogin) {
          session = await connectionManager.openSession(userId, adapter.id, connectionManager.browserModeFor(adapter, prefs.show_browser));
          if (!session.ok) {
            summary.skipped_reason = session.reason;
            await runStep('platform_login', 'paused', { platform: adapter.id, reason: session.reason });
            continue;
          }
        }

        const candidates = await this.collectCandidates(userId, adapter, session, query, prefs, profile, summary, runStep);
        totals.scanned += summary.discovered;

        // Best matches first; final eligibility (with full description) happens per job
        const ranked = candidates
          .map((job) => ({ job, score: matchingEngine.calculateMatch(profile, job, roles).overall_match_score }))
          .filter((c) => c.score >= Math.max(0, prefs.minimum_match_score - 15))
          .sort((a, b) => b.score - a.score)
          .map((c) => c.job);

        const platformLimit = Math.max(0, (prefs.per_platform_daily_limit ?? 15) - (await countSubmittedToday(userId, adapter.id)));
        let processedOnPlatform = 0;
        await progress({ phase: 'applying', platform: adapter.id, queue_total: ranked.length, queue_done: 0 });

        for (const job of ranked) {
          if (state.cancelled) break;
          if (processedOnPlatform >= platformLimit) {
            await runStep('platform_limit_reached', 'warning', { platform: adapter.id, limit: prefs.per_platform_daily_limit });
            break;
          }
          if (!dryRun && remainingToday <= 0) break;

          await progress({
            phase: 'applying',
            platform: adapter.id,
            current_job: `${job.title} at ${job.company}`,
            queue_total: ranked.length,
            queue_done: processedOnPlatform,
          });
          const result = await automationWorker.processJob(userId, job, { runId: run.id, dryRun, session: session || undefined });

          if (result.status === 'SUBMITTED') {
            totals.matched++;
            totals.submitted++;
            summary.applied++;
            remainingToday--;
            processedOnPlatform++;
          } else if (result.status === 'APPLICATION_READY') {
            totals.matched++;
            summary.applied++;
            processedOnPlatform++;
          } else if (result.status === 'REQUIRES_HUMAN_ACTION') {
            totals.matched++;
            totals.human++;
            summary.needs_action++;
          } else if (result.status === 'FAILED') {
            totals.failed++;
            summary.failed++;
          }

          if (result.sessionExpired) {
            summary.skipped_reason = result.message;
            await runStep('platform_session_lost', 'paused', { platform: adapter.id, reason: result.message });
            break;
          }
          if (['SUBMITTED', 'APPLICATION_READY', 'REQUIRES_HUMAN_ACTION', 'FAILED'].includes(result.status)) {
            await this.politePause(state);
          }
        }
      } catch (err: any) {
        summary.skipped_reason = err.message?.split('\n')[0];
        await runStep('platform_error', 'failed', { platform: adapter.id, error: summary.skipped_reason });
        await repo.addError({ run_id: run.id, error_type: 'PLATFORM_ERROR', message: `${adapter.name}: ${summary.skipped_reason}`, resolved: false });
      } finally {
        if (session) await session.close().catch(() => {});
      }
    }

    const status = state.cancelled ? 'cancelled' : 'completed';
    await progress({ phase: 'finished', message: state.cancelled ? 'Stopped by user' : 'Run complete' });
    await repo.updateRun(run.id, { status, ended_at: new Date().toISOString() });
    await runStep('run_finished', 'success', { status, ...totals });
    logger.info({ userId, runId: run.id, status, ...totals }, 'Automation run finished');
  }

  /** Why a login platform cannot be used right now (null = go ahead). */
  private async loginProblem(userId: string, adapter: PlatformAdapter): Promise<string | null> {
    if (!adapter.requiresLogin) return null;
    if (connectionManager.isConnecting(userId, adapter.id)) return `${adapter.name} is being connected right now.`;
    const cred = await getRepository().getCredential(userId, adapter.id);
    const hasSession = await sessionStore.has(userId, adapter.id);
    if (!cred?.password_enc && !hasSession) return `Connect your ${adapter.name} account on the Platforms page.`;
    return null;
  }

  private async collectCandidates(
    userId: string,
    adapter: PlatformAdapter,
    session: PlatformSession | null,
    query: ReturnType<typeof buildSearchQuery>,
    prefs: Awaited<ReturnType<ReturnType<typeof getRepository>['getPreferences']>>,
    profile: Awaited<ReturnType<ReturnType<typeof getRepository>['getProfile']>>,
    summary: PlatformRunSummary,
    runStep: (name: string, status: 'success' | 'warning' | 'failed' | 'paused', details: Record<string, any>) => Promise<unknown>
  ): Promise<NormalizedJob[]> {
    const repo = getRepository();
    const byId = new Map<string, NormalizedJob>();

    try {
      const discovered = await adapter.search({
        query,
        prefs,
        profile,
        getPage: session ? async () => session.page : undefined,
        log: (message, details) => void runStep(message, 'success', { platform: adapter.id, ...(details || {}) }),
      });
      for (const d of discovered) {
        const saved = await repo.upsertJob(d);
        byId.set(saved.id, saved);
      }
      summary.discovered = discovered.length;
      await runStep('discovery', 'success', { platform: adapter.id, found: discovered.length });
    } catch (err: any) {
      await runStep('discovery', 'failed', { platform: adapter.id, error: err.message?.split('\n')[0] });
      if (adapter.id !== 'Direct Portals') throw err;
    }

    // Jobs found earlier (or added manually) that have not been applied to yet
    const { jobs: known } = await repo.getJobs({ platform: adapter.id === 'Direct Portals' ? undefined : adapter.id, limit: 500 });
    // Manually added jobs are always eligible; discovered ones only while they still fit the current search
    const pool =
      adapter.id === 'Direct Portals'
        ? known.filter((j) => /direct|portal|careers/i.test(j.platform) && !getAdapter(j.platform))
        : known.filter((j) => j.external_id.startsWith('user-') || titleMatchesAny(j.title, query.keywords, 0.5));
    for (const job of pool) {
      if (byId.has(job.id) || !job.is_active) continue;
      byId.set(job.id, job);
    }

    const answered = new Set(
      (await repo.getAnswerBank(userId)).filter((e) => e.answer).map((e) => normalizeQuestion(e.question))
    );
    const candidates: NormalizedJob[] = [];
    for (const job of byId.values()) {
      const app = await repo.getApplicationByJob(userId, job.id);
      if (!app) {
        candidates.push(job);
        continue;
      }
      const profileChangedSince = Date.parse(profile.updated_at) > Date.parse(app.updated_at);
      const retryable =
        (app.status === 'FAILED' && (app.attempt_count || 0) < RETRYABLE_ATTEMPTS) ||
        (app.status === 'NOT_ELIGIBLE' && profileChangedSince) ||
        // Prepared in a dry run and now running for real
        (app.status === 'APPLICATION_READY' && prefs.automation_mode === 'production') ||
        // Waiting only on screening questions that the user has answered since
        (app.status === 'REQUIRES_HUMAN_ACTION' &&
          (app.unanswered_questions || []).length > 0 &&
          (app.attempt_count || 0) < RETRYABLE_ATTEMPTS + 2 &&
          (app.unanswered_questions || []).every((q) => answered.has(normalizeQuestion(q))));
      if (retryable) candidates.push(job);
    }
    return candidates.slice(0, Math.max(query.limit * 2, 10));
  }

  /**
   * Searches platforms without applying (Jobs page "Scan"). Platforms whose
   * search only works inside a logged-in browser are searched during runs.
   */
  async discover(userId: string, platformIds?: string[]): Promise<{ platform: string; found: number; error?: string; skipped?: string }[]> {
    const repo = getRepository();
    const [profile, prefs] = await Promise.all([repo.getProfile(userId), repo.getPreferences(userId)]);
    const query = buildSearchQuery(prefs, profile);
    const roles = [...(prefs.preferred_roles || []), ...query.keywords];
    const ids = (platformIds?.length ? platformIds : prefs.enabled_platforms || []).map((p) => getAdapter(p)).filter(Boolean) as PlatformAdapter[];
    const results: { platform: string; found: number; error?: string; skipped?: string }[] = [];
    for (const adapter of ids) {
      if (adapter.id === 'Direct Portals') continue;
      if (adapter.searchNeedsBrowser) {
        results.push({ platform: adapter.id, found: 0, skipped: 'Searched during automation runs (needs your logged-in browser session)' });
        continue;
      }
      try {
        const found = await adapter.search({ query, prefs, profile, log: () => undefined });
        for (const d of found) {
          const saved = await repo.upsertJob(d);
          await repo.saveMatch(matchingEngine.calculateMatch(profile, saved, roles));
        }
        results.push({ platform: adapter.id, found: found.length });
      } catch (err: any) {
        results.push({ platform: adapter.id, found: 0, error: err.message?.split('\n')[0] });
      }
    }
    return results;
  }

  private async politePause(state: RunState): Promise<void> {
    const total = env.APPLY_DELAY_MS + Math.floor(Math.random() * env.APPLY_DELAY_MS * 0.5);
    const until = Date.now() + total;
    while (Date.now() < until && !state.cancelled) {
      await sleep(Math.min(1000, until - Date.now()));
    }
  }
}

export const orchestrator = new AutomationOrchestrator();
