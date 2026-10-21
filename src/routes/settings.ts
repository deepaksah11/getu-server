import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { getRepository } from '../db/client.js';
import { getUserId } from '../utils/auth.js';
import { logger } from '../config/logger.js';
import { getAdapter } from '../automation/platforms/registry.js';

export const settingsRouter = Router();

const stringList = z.array(z.string().trim().max(200)).max(100).transform((list) => list.filter(Boolean));

const PreferencesUpdateSchema = z
  .object({
    minimum_match_score: z.coerce.number().min(0).max(100),
    max_applications_per_day: z.coerce.number().int().min(1).max(200),
    preferred_roles: stringList,
    preferred_locations: stringList,
    work_modes: z.array(z.enum(['Remote', 'Hybrid', 'Onsite'])),
    excluded_companies: stringList,
    excluded_keywords: stringList,
    enabled_platforms: z.array(z.string()).transform((list) => list.map((p) => getAdapter(p)?.id).filter((p): p is string => Boolean(p))),
    automation_enabled: z.boolean(),
    automation_mode: z.enum(['dry-run', 'production']),
    schedule_interval_mins: z.coerce.number().int().min(10).max(10080),
    search_keywords: stringList,
    search_locations: stringList,
    jobs_per_platform: z.coerce.number().int().min(1).max(50),
    posted_within_days: z.coerce.number().int().min(1).max(60),
    per_platform_daily_limit: z.coerce.number().int().min(1).max(100),
    show_browser: z.boolean(),
    greenhouse_boards: stringList,
    lever_companies: stringList,
    ashby_boards: stringList,
    naukri_upload_tailored_resume: z.boolean(),
  })
  .partial();

settingsRouter.get('/', async (req: Request, res: Response) => {
  try {
    const prefs = await getRepository().getPreferences(getUserId(req));
    // Older versions stored platforms that are no longer supported (e.g. "Wellfound")
    const enabled = (prefs.enabled_platforms || []).map((p) => getAdapter(p)?.id).filter((p): p is string => Boolean(p));
    res.json({ success: true, data: { ...prefs, enabled_platforms: enabled } });
  } catch (err: any) {
    logger.error({ err: err.message }, 'Failed fetching settings');
    res.status(500).json({ success: false, error: err.message });
  }
});

settingsRouter.put('/', async (req: Request, res: Response) => {
  const parsed = PreferencesUpdateSchema.safeParse(req.body || {});
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return res.status(400).json({ success: false, error: `Invalid ${first.path.join('.')}: ${first.message}` });
  }
  try {
    const updated = await getRepository().updatePreferences(getUserId(req), parsed.data);
    res.json({ success: true, data: updated });
  } catch (err: any) {
    logger.error({ err: err.message }, 'Failed updating settings');
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/settings/clear-data - clear this user's application and run history
settingsRouter.post('/clear-data', async (req: Request, res: Response) => {
  try {
    const keepJobs = req.body?.keepJobs ?? true;
    await getRepository().clearData(getUserId(req), keepJobs);
    res.json({ success: true, message: 'Your application and automation history was cleared.' });
  } catch (err: any) {
    logger.error({ err: err.message }, 'Failed clearing data');
    res.status(500).json({ success: false, error: err.message });
  }
});
