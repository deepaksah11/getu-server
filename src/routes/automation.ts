import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { getRepository } from '../db/client.js';
import { getUserId } from '../utils/auth.js';
import { scheduler } from '../scheduler/scheduler.js';
import { orchestrator } from '../queue/orchestrator.js';
import { logger } from '../config/logger.js';
import { aiService } from '../ai/aiService.js';
import { buildSearchQuery, profileReadiness } from '../automation/readiness.js';
import { getAdapter } from '../automation/platforms/registry.js';
import { connectionManager } from '../automation/connectionManager.js';
import { sessionStore } from '../automation/security/sessionStore.js';

export const automationRouter = Router();

async function readinessFor(userId: string) {
  const repo = getRepository();
  const [profile, prefs] = await Promise.all([repo.getProfile(userId), repo.getPreferences(userId)]);
  const platforms = await Promise.all(
    (prefs.enabled_platforms || [])
      .map((p) => getAdapter(p))
      .filter((a): a is NonNullable<typeof a> => Boolean(a))
      .map(async (adapter) => {
        if (!adapter.requiresLogin) return { id: adapter.id, name: adapter.name, ready: true, reason: 'No login needed' };
        const cred = await repo.getCredential(userId, adapter.id);
        const hasSession = await sessionStore.has(userId, adapter.id);
        if (connectionManager.isConnecting(userId, adapter.id)) return { id: adapter.id, name: adapter.name, ready: false, reason: 'Connecting...' };
        if (!cred?.password_enc && !hasSession) return { id: adapter.id, name: adapter.name, ready: false, reason: 'Enter your login on the Platforms page' };
        if (cred?.status === 'needs_verification') return { id: adapter.id, name: adapter.name, ready: false, reason: cred.last_error || 'Verification needed: click Connect' };
        if (cred?.status === 'failed') return { id: adapter.id, name: adapter.name, ready: false, reason: cred.last_error || 'Login failed' };
        return { id: adapter.id, name: adapter.name, ready: true, reason: cred?.status === 'connected' ? 'Connected' : 'Login saved (verified on first run)' };
      })
  );
  const profileCheck = profileReadiness(profile);
  const pendingQuestions = (await repo.getAnswerBank(userId)).filter((e) => !e.answer).length;
  return {
    ready: profileCheck.ready && platforms.some((p) => p.ready),
    profile: profileCheck,
    platforms,
    search: buildSearchQuery(prefs, profile),
    ai_engine: aiService.hasProvider() ? 'gemini' : 'offline',
    mode: prefs.automation_mode,
    pending_questions: pendingQuestions,
  };
}

// GET /api/automation/status - live status, latest run progress and counters
automationRouter.get('/status', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const status = await scheduler.getStatus(userId);
    const stats = await getRepository().getDashboardStats(userId);
    res.json({
      success: true,
      data: {
        ...status,
        stats: {
          jobs_found: stats.jobs_found,
          matched: stats.matched,
          applied: stats.applied,
          failed: stats.failed,
          needs_attention: stats.needs_attention,
          resumes_generated: stats.resumes_generated,
        },
      },
    });
  } catch (err: any) {
    logger.error({ err: err.message }, 'Failed fetching automation status');
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/automation/readiness - what is still missing before automation can run
automationRouter.get('/readiness', async (req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await readinessFor(getUserId(req)) });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/automation/start - enable the schedule (and optionally run right away)
automationRouter.post('/start', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    await scheduler.resume(userId);
    let runId: string | undefined;
    if (req.body?.runNow) {
      runId = (await scheduler.runNow(userId)).runId;
    }
    res.json({ success: true, data: { ...(await scheduler.getStatus(userId)), runId }, message: 'Automatic applying is on.' });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

automationRouter.post('/resume', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    await scheduler.resume(userId);
    res.json({ success: true, data: await scheduler.getStatus(userId), message: 'Automatic applying is on.' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

automationRouter.post('/pause', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    await scheduler.pause(userId);
    res.json({ success: true, data: await scheduler.getStatus(userId), message: 'Scheduled runs paused.' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/automation/run-now - start a full run in the background
automationRouter.post('/run-now', async (req: Request, res: Response) => {
  const parsed = z
    .object({ platforms: z.array(z.string()).optional(), dryRun: z.boolean().optional() })
    .safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ success: false, error: 'Invalid run options' });
  const userId = getUserId(req);
  if (orchestrator.isRunning(userId)) {
    return res.status(409).json({ success: false, error: 'A run is already in progress.' });
  }
  try {
    const { runId } = await scheduler.runNow(userId, parsed.data);
    res.status(202).json({ success: true, data: { runId }, message: 'Automation run started: searching jobs and applying in the background.' });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// POST /api/automation/stop - stop the current run after the job in progress
automationRouter.post('/stop', async (req: Request, res: Response) => {
  const stopped = scheduler.stop(getUserId(req));
  res.json({ success: stopped, message: stopped ? 'Stopping after the current job.' : 'No run in progress.' });
});

automationRouter.get('/runs', async (req: Request, res: Response) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 20;
    res.json({ success: true, data: await getRepository().getRuns(getUserId(req), limit) });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/automation/steps - step log for the user's runs (or one run / application)
automationRouter.get('/steps', async (req: Request, res: Response) => {
  try {
    const repo = getRepository();
    const userId = getUserId(req);
    const runId = req.query.runId as string | undefined;
    const applicationId = req.query.applicationId as string | undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
    if (runId || applicationId) {
      return res.json({ success: true, data: await repo.getSteps(runId, applicationId, limit) });
    }
    const runIds = new Set((await repo.getRuns(userId, 100)).map((r) => r.id));
    const steps = (await repo.getSteps(undefined, undefined, 3000)).filter((s) => runIds.has(s.run_id)).slice(0, limit);
    res.json({ success: true, data: steps });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

automationRouter.get('/errors', async (req: Request, res: Response) => {
  try {
    const repo = getRepository();
    const runId = req.query.runId as string | undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
    if (runId) return res.json({ success: true, data: await repo.getErrors(runId, limit) });
    const runIds = new Set((await repo.getRuns(getUserId(req), 100)).map((r) => r.id));
    const errors = (await repo.getErrors(undefined, 1000)).filter((e) => e.run_id && runIds.has(e.run_id)).slice(0, limit);
    res.json({ success: true, data: errors });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

automationRouter.post('/errors/:id/resolve', async (req: Request, res: Response) => {
  try {
    res.json({ success: await getRepository().resolveError(req.params.id) });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});
