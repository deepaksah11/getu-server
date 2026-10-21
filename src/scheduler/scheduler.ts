import { env } from '../config/env.js';
import { getRepository } from '../db/client.js';
import { logger } from '../config/logger.js';
import { orchestrator, StartOptions } from '../queue/orchestrator.js';

/**
 * Starts automation runs for every user who enabled scheduling, once their
 * interval has passed since the last run.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  public async init(): Promise<void> {
    try {
      const repo = getRepository();
      const recovered = await repo.recoverInterrupted();
      if (recovered.runs || recovered.applications) {
        logger.warn(recovered, 'Recovered runs/applications interrupted by the last shutdown');
      }
    } catch (err: any) {
      logger.warn({ err: err?.message || err }, 'Could not recover interrupted runs on startup; continuing');
    }
    this.startTimer();
  }

  private startTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((err: any) => {
        logger.warn({ err: err?.message || err }, 'Automation scheduler tick encountered an error');
      });
    }, env.SCHEDULER_TICK_MS);
    this.timer.unref?.();
    logger.info({ tickMs: env.SCHEDULER_TICK_MS }, 'Automation scheduler started');
  }

  /** Checks every user's schedule; exposed for tests. */
  public async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const all = await getRepository().getAllPreferences();
      for (const prefs of all) {
        if (!prefs.automation_enabled || orchestrator.isRunning(prefs.user_id)) continue;
        const intervalMs = Math.max(10, prefs.schedule_interval_mins || 60) * 60 * 1000;
        const last = prefs.last_run_at ? Date.parse(prefs.last_run_at) : 0;
        if (Date.now() - last < intervalMs) continue;
        try {
          await orchestrator.start(prefs.user_id, { trigger: 'scheduled' });
          logger.info({ userId: prefs.user_id }, 'Scheduled automation run started');
        } catch (err: any) {
          logger.warn({ userId: prefs.user_id, err: err?.message || err }, 'Scheduled run could not start');
        }
      }
    } catch (err: any) {
      logger.warn({ err: err?.message || err }, 'Scheduler tick error');
    } finally {
      this.ticking = false;
    }
  }

  public async pause(userId: string): Promise<void> {
    await getRepository().updatePreferences(userId, { automation_enabled: false });
    logger.info({ userId }, 'Automation schedule paused');
  }

  public async resume(userId: string): Promise<void> {
    await getRepository().updatePreferences(userId, { automation_enabled: true });
    this.startTimer();
    logger.info({ userId }, 'Automation schedule enabled');
  }

  public async runNow(userId: string, options: StartOptions = {}): Promise<{ runId: string }> {
    return orchestrator.start(userId, { trigger: 'manual', ...options });
  }

  public stop(userId: string): boolean {
    return orchestrator.stop(userId);
  }

  public async getStatus(userId: string) {
    const repo = getRepository();
    const prefs = await repo.getPreferences(userId);
    const runs = await repo.getRuns(userId, 1);
    const latest = runs[0];
    const isRunning = orchestrator.isRunning(userId);
    const intervalMs = Math.max(10, prefs.schedule_interval_mins || 60) * 60 * 1000;
    const nextRunAt =
      prefs.automation_enabled && !isRunning
        ? new Date(Math.max(Date.now(), (prefs.last_run_at ? Date.parse(prefs.last_run_at) : Date.now()) + intervalMs)).toISOString()
        : undefined;

    return {
      enabled: prefs.automation_enabled,
      mode: prefs.automation_mode,
      intervalMins: prefs.schedule_interval_mins,
      isRunning,
      activeRunId: orchestrator.activeRunId(userId),
      lastRunAt: prefs.last_run_at,
      nextRunAt,
      latestRun: latest
        ? {
            id: latest.id,
            status: latest.status,
            progress: latest.progress,
            platforms: latest.platforms,
            started_at: latest.started_at,
            ended_at: latest.ended_at,
            error_message: latest.error_message,
            jobs_scanned: latest.jobs_scanned,
            applications_submitted: latest.applications_submitted,
            human_verification_required: latest.human_verification_required,
            applications_failed: latest.applications_failed,
          }
        : null,
    };
  }

  public shutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export const scheduler = new Scheduler();
