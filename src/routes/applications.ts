import path from 'path';
import { Router, Request, Response } from 'express';
import { getRepository } from '../db/client.js';
import { getUserId } from '../utils/auth.js';
import { automationWorker } from '../automation/worker.js';
import { logger } from '../config/logger.js';
import { Application, ApplicationStatus } from '../types/index.js';
import { ApplicationStateMachine } from '../queue/stateMachine.js';

export const applicationsRouter = Router();

/** Adds browser-loadable URLs for files the automation saved. */
function withUrls(app: Application) {
  const shot = app.screenshot_path || app.submission_receipt?.screenshot_path;
  return {
    ...app,
    screenshot_url: shot ? `/data/screenshots/${path.basename(shot)}` : undefined,
  };
}

function dryRunFromBody(body: any): boolean | undefined {
  if (body?.forceProduction === true) return false;
  if (typeof body?.dryRun === 'boolean') return body.dryRun;
  return undefined;
}

applicationsRouter.get('/', async (req: Request, res: Response) => {
  try {
    const repo = getRepository();
    const userId = getUserId(req);
    const status = req.query.status as ApplicationStatus | undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
    const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : 0;
    const { applications, total } = await repo.getApplications(userId, { status, limit, offset });
    res.json({ success: true, data: applications.map(withUrls), pagination: { total, limit, offset } });
  } catch (err: any) {
    logger.error({ err: err.message }, 'Failed fetching applications');
    res.status(500).json({ success: false, error: err.message });
  }
});

applicationsRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const repo = getRepository();
    const application = await repo.getApplication(req.params.id);
    if (!application || application.user_id !== getUserId(req)) {
      return res.status(404).json({ success: false, error: 'Application not found' });
    }
    const steps = await repo.getSteps(undefined, application.id, 100);
    const questions = await repo.getQuestions(application.id);
    res.json({ success: true, data: { ...withUrls(application), timeline_steps: steps, questions } });
  } catch (err: any) {
    logger.error({ err: err.message }, 'Failed fetching application details');
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/applications/apply/:jobId - tailor a resume and apply to one job now
applicationsRouter.post('/apply/:jobId', async (req: Request, res: Response) => {
  try {
    const repo = getRepository();
    const userId = getUserId(req);
    const job = await repo.getJob(req.params.jobId);
    if (!job) return res.status(404).json({ success: false, error: 'Job not found' });

    const result = await automationWorker.processJob(userId, job, { manual: true, dryRun: dryRunFromBody(req.body) });
    const application = await repo.getApplicationByJob(userId, job.id);
    res.json({
      success: result.success,
      status: result.status,
      message: result.message,
      application: application ? withUrls(application) : null,
    });
  } catch (err: any) {
    logger.error({ err: err.message }, 'Failed triggering application');
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/applications/:id/retry
applicationsRouter.post('/:id/retry', async (req: Request, res: Response) => {
  try {
    const repo = getRepository();
    const userId = getUserId(req);
    const app = await repo.getApplication(req.params.id);
    if (!app || app.user_id !== userId) return res.status(404).json({ success: false, error: 'Application not found' });
    const job = await repo.getJob(app.job_id);
    if (!job) return res.status(404).json({ success: false, error: 'Job not found' });

    const result = await automationWorker.processJob(userId, job, { manual: true, dryRun: dryRunFromBody(req.body) });
    const updated = await repo.getApplication(app.id);
    res.json({
      success: result.success,
      status: result.status,
      message: result.message,
      application: updated ? withUrls(updated) : null,
    });
  } catch (err: any) {
    logger.error({ err: err.message }, 'Failed retrying application');
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/applications/:id/mark-submitted - the user finished an application by hand
applicationsRouter.post('/:id/mark-submitted', async (req: Request, res: Response) => {
  try {
    const repo = getRepository();
    const app = await repo.getApplication(req.params.id);
    if (!app || app.user_id !== getUserId(req)) return res.status(404).json({ success: false, error: 'Application not found' });
    await ApplicationStateMachine.transition(app.id, 'SUBMITTED');
    const updated = await repo.updateApplication(app.id, {
      submission_verified: false,
      submission_receipt: { ...(app.submission_receipt || {}), timestamp: new Date().toISOString(), message: 'Marked as applied by you.' },
    });
    res.json({ success: true, application: withUrls(updated) });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});
