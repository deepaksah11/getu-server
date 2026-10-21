import { Router, Request, Response } from 'express';
import { getRepository } from '../db/client.js';
import { getUserId } from '../utils/auth.js';
import { logger } from '../config/logger.js';

export const analyticsRouter = Router();

// GET /api/dashboard - Dashboard summary data
analyticsRouter.get('/dashboard', async (req: Request, res: Response) => {
  try {
    const repo = getRepository();
    const userId = getUserId(req);
    const stats = await repo.getDashboardStats(userId);
    res.json({ success: true, data: stats });
  } catch (err: any) {
    logger.error({ err: err.message }, 'Failed fetching dashboard stats');
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/analytics - Deep analytics data
analyticsRouter.get('/', async (req: Request, res: Response) => {
  try {
    const repo = getRepository();
    const userId = getUserId(req);
    const data = await repo.getAnalytics(userId);
    res.json({ success: true, data });
  } catch (err: any) {
    logger.error({ err: err.message }, 'Failed fetching analytics data');
    res.status(500).json({ success: false, error: err.message });
  }
});
