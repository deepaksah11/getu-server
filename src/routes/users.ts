import { Router, Request, Response } from 'express';
import { getRepository } from '../db/client.js';
import { getUserId } from '../utils/auth.js';
import { logger } from '../config/logger.js';

export const usersRouter = Router();

// GET /api/users - List users with active profile preview
usersRouter.get('/', async (req: Request, res: Response) => {
  try {
    const repo = getRepository();
    const users = await repo.getUsers();
    const activeUserId = getUserId(req);

    const enriched = await Promise.all(
      users.map(async (u) => {
        const profile = await repo.getProfile(u.id);
        return {
          id: u.id,
          email: u.email,
          full_name: profile.full_name || 'Anonymous User',
          headline: profile.professional_summary?.slice(0, 60) || '',
          skills_count: profile.skills.length,
          is_active: u.id === activeUserId,
          created_at: u.created_at,
        };
      })
    );

    res.json({
      success: true,
      data: enriched,
      active_user_id: activeUserId,
    });
  } catch (err: any) {
    logger.error({ err: err.message }, 'Failed fetching users');
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/users/current - Get current user and active profile
usersRouter.get('/current', async (req: Request, res: Response) => {
  try {
    const repo = getRepository();
    const activeUserId = getUserId(req);
    const user = await repo.getUser(activeUserId);
    const profile = await repo.getProfile(activeUserId);

    res.json({
      success: true,
      data: {
        id: activeUserId,
        email: user?.email || profile.email || 'user@example.com',
        full_name: profile.full_name || 'Candidate',
        profile,
      },
    });
  } catch (err: any) {
    logger.error({ err: err.message }, 'Failed fetching current user');
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/users - Create new candidate user profile
usersRouter.post('/', async (req: Request, res: Response) => {
  try {
    const repo = getRepository();
    const { email, full_name } = req.body;

    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ success: false, error: 'A valid email address is required.' });
    }

    logger.info({ email, full_name }, 'Creating new user profile');
    const result = await repo.createUser(email.trim(), full_name ? String(full_name).trim() : undefined);

    res.json({
      success: true,
      data: {
        user: result.user,
        profile: result.profile,
      },
      message: `User profile created for ${result.profile.full_name}!`,
    });
  } catch (err: any) {
    logger.error({ err: err.message }, 'Failed creating user');
    res.status(500).json({ success: false, error: err.message });
  }
});
