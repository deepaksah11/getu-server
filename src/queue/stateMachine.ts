import { Application, ApplicationStatus } from '../types/index.js';
import { getRepository } from '../db/client.js';
import { logger } from '../config/logger.js';

const VALID_TRANSITIONS: Record<ApplicationStatus, ApplicationStatus[]> = {
  DISCOVERED: ['ANALYZING', 'DUPLICATE', 'FAILED'],
  ANALYZING: ['MATCHED', 'NOT_ELIGIBLE', 'FAILED'],
  MATCHED: ['RESUME_GENERATING', 'NOT_ELIGIBLE', 'FAILED'],
  NOT_ELIGIBLE: ['ANALYZING'], // re-evaluated when the profile or preferences change
  RESUME_GENERATING: ['RESUME_READY', 'FAILED'],
  RESUME_READY: ['APPLICATION_READY', 'FAILED'],
  APPLICATION_READY: ['APPLYING', 'ANALYZING', 'FAILED', 'REQUIRES_HUMAN_ACTION'],
  APPLYING: ['SUBMITTED', 'APPLICATION_READY', 'DUPLICATE', 'REQUIRES_HUMAN_ACTION', 'FAILED'],
  SUBMITTED: [], // terminal
  FAILED: ['ANALYZING', 'APPLYING'], // retry
  REQUIRES_HUMAN_ACTION: ['ANALYZING', 'APPLYING', 'FAILED'], // resumes once the user has acted
  DUPLICATE: [], // terminal: already applied on the platform
};

export class ApplicationStateMachine {
  public static isValidTransition(from: ApplicationStatus, to: ApplicationStatus): boolean {
    const allowed = VALID_TRANSITIONS[from];
    return allowed ? allowed.includes(to) : false;
  }

  public static async transition(
    applicationId: string,
    to: ApplicationStatus,
    reason?: string
  ): Promise<void> {
    const repo = getRepository();
    const app = await repo.getApplication(applicationId);
    if (!app) {
      throw new Error(`Application ${applicationId} not found`);
    }

    const from = app.status;
    if (from !== to && !this.isValidTransition(from, to)) {
      logger.warn({ applicationId, from, to }, 'Application state transition outside the standard path');
    }

    const updates: Partial<Application> = { status: to };
    if (to === 'FAILED') {
      updates.failure_reason = reason || 'Unknown failure occurred';
    } else if (to === 'REQUIRES_HUMAN_ACTION') {
      updates.requires_human_reason = reason || 'Security challenge or human verification detected';
    } else if (to === 'NOT_ELIGIBLE') {
      updates.failure_reason = reason;
    } else if (to === 'SUBMITTED') {
      updates.applied_at = new Date().toISOString();
    }

    await repo.updateApplication(applicationId, updates);
    logger.debug({ applicationId, from, to, reason }, 'Application state updated');
  }
}
