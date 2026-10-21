import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { getRepository } from '../db/client.js';
import { getUserId } from '../utils/auth.js';
import { logger } from '../config/logger.js';
import { env } from '../config/env.js';
import { PLATFORM_ADAPTERS, getAdapter } from '../automation/platforms/registry.js';
import { PlatformAdapter } from '../automation/platforms/types.js';
import { connectionManager } from '../automation/connectionManager.js';
import { sessionStore } from '../automation/security/sessionStore.js';
import { DEFAULT_ASHBY_BOARDS, DEFAULT_GREENHOUSE_BOARDS, DEFAULT_LEVER_COMPANIES } from '../db/seed.js';

export const platformsRouter = Router();

async function describe(userId: string, adapter: PlatformAdapter, enabled: string[]) {
  const repo = getRepository();
  const cred = adapter.requiresLogin ? await repo.getCredential(userId, adapter.id) : null;
  const hasSession = adapter.requiresLogin ? await sessionStore.has(userId, adapter.id) : false;
  return {
    id: adapter.id,
    name: adapter.name,
    description: adapter.description,
    notes: adapter.notes,
    requires_login: adapter.requiresLogin,
    needs_visible_browser: Boolean(adapter.needsVisibleBrowser),
    can_search: adapter.id !== 'Direct Portals',
    enabled: enabled.some((e) => e.toLowerCase() === adapter.id.toLowerCase()),
    connection: adapter.requiresLogin
      ? {
          status: connectionManager.isConnecting(userId, adapter.id)
            ? cred?.status === 'awaiting_user'
              ? 'awaiting_user'
              : 'connecting'
            : cred?.status || 'not_connected',
          username: cred?.username || '',
          has_password: Boolean(cred?.password_enc),
          has_session: hasSession,
          last_verified_at: cred?.last_verified_at,
          last_error: cred?.last_error,
        }
      : null,
  };
}

function visibleAdapters(enabled: string[]) {
  return PLATFORM_ADAPTERS.filter((a) => !a.hidden || env.SEED_DEMO_DATA || enabled.includes(a.id));
}

// GET /api/platforms - catalog with the user's selection and connection status
platformsRouter.get('/', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const prefs = await getRepository().getPreferences(userId);
    const enabled = prefs.enabled_platforms || [];
    const data = await Promise.all(visibleAdapters(enabled).map((a) => describe(userId, a, enabled)));
    res.json({
      success: true,
      data,
      enabled_platforms: enabled.filter((e) => getAdapter(e)),
      boards: {
        greenhouse_boards: prefs.greenhouse_boards?.length ? prefs.greenhouse_boards : DEFAULT_GREENHOUSE_BOARDS,
        lever_companies: prefs.lever_companies?.length ? prefs.lever_companies : DEFAULT_LEVER_COMPANIES,
        ashby_boards: prefs.ashby_boards?.length ? prefs.ashby_boards : DEFAULT_ASHBY_BOARDS,
      },
    });
  } catch (err: any) {
    logger.error({ err: err.message }, 'Failed listing platforms');
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/platforms/:id - one platform's status (polled while connecting)
platformsRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const adapter = getAdapter(req.params.id);
    if (!adapter) return res.status(404).json({ success: false, error: 'Unknown platform' });
    const userId = getUserId(req);
    const prefs = await getRepository().getPreferences(userId);
    res.json({ success: true, data: await describe(userId, adapter, prefs.enabled_platforms || []) });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/platforms/enabled - choose which platforms automation applies on
platformsRouter.put('/enabled', async (req: Request, res: Response) => {
  try {
    const parsed = z.object({ enabled_platforms: z.array(z.string()).max(20) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: 'enabled_platforms must be a list of platform ids' });
    const ids = Array.from(new Set(parsed.data.enabled_platforms.map((p) => getAdapter(p)?.id).filter(Boolean))) as string[];
    const updated = await getRepository().updatePreferences(getUserId(req), { enabled_platforms: ids });
    res.json({ success: true, data: updated.enabled_platforms });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/platforms/boards - company boards watched on Greenhouse / Lever / Ashby
platformsRouter.put('/boards', async (req: Request, res: Response) => {
  try {
    const slugList = z
      .array(z.string())
      .max(200)
      .transform((list) => Array.from(new Set(list.map((s) => s.trim().toLowerCase()).filter((s) => /^[a-z0-9][a-z0-9-_.]{0,80}$/.test(s)))));
    const parsed = z
      .object({ greenhouse_boards: slugList.optional(), lever_companies: slugList.optional(), ashby_boards: slugList.optional() })
      .safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: 'Invalid board lists' });
    const updated = await getRepository().updatePreferences(getUserId(req), parsed.data);
    res.json({
      success: true,
      data: { greenhouse_boards: updated.greenhouse_boards, lever_companies: updated.lever_companies, ashby_boards: updated.ashby_boards },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/platforms/:id/credentials - save username/password once (encrypted) and verify in the background
platformsRouter.put('/:id/credentials', async (req: Request, res: Response) => {
  try {
    const adapter = getAdapter(req.params.id);
    if (!adapter) return res.status(404).json({ success: false, error: 'Unknown platform' });
    const parsed = z
      .object({ username: z.string().trim().min(3).max(200), password: z.string().max(500).optional(), verify: z.boolean().optional() })
      .safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: 'Enter your login email/phone and password.' });
    const userId = getUserId(req);
    await connectionManager.saveCredentials(userId, adapter.id, parsed.data.username, parsed.data.password || undefined);
    if (parsed.data.verify !== false) {
      connectionManager.startConnect(userId, adapter.id, false);
    }
    const prefs = await getRepository().getPreferences(userId);
    res.json({ success: true, data: await describe(userId, adapter, prefs.enabled_platforms || []) });
  } catch (err: any) {
    logger.warn({ err: err.message, platform: req.params.id }, 'Saving credentials failed');
    res.status(400).json({ success: false, error: err.message });
  }
});

// DELETE /api/platforms/:id/credentials - forget the login and the saved session
platformsRouter.delete('/:id/credentials', async (req: Request, res: Response) => {
  try {
    const adapter = getAdapter(req.params.id);
    if (!adapter) return res.status(404).json({ success: false, error: 'Unknown platform' });
    await connectionManager.removeCredentials(getUserId(req), adapter.id);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/platforms/:id/connect - sign in now; interactive opens a visible window for OTP / CAPTCHA
platformsRouter.post('/:id/connect', async (req: Request, res: Response) => {
  try {
    const adapter = getAdapter(req.params.id);
    if (!adapter?.requiresLogin) return res.status(400).json({ success: false, error: 'This platform does not need a login' });
    const userId = getUserId(req);
    connectionManager.startConnect(userId, adapter.id, req.body?.interactive !== false);
    const prefs = await getRepository().getPreferences(userId);
    res.status(202).json({ success: true, data: await describe(userId, adapter, prefs.enabled_platforms || []) });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});
