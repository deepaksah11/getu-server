import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { env } from './config/env.js';
import { paths } from './config/paths.js';
import { logger } from './config/logger.js';
import { getRepository } from './db/client.js';
import { scheduler } from './scheduler/scheduler.js';
import { orchestrator } from './queue/orchestrator.js';
import { browserPool } from './automation/browser/browserPool.js';

import { jobsRouter } from './routes/jobs.js';
import { resumesRouter } from './routes/resumes.js';
import { applicationsRouter } from './routes/applications.js';
import { profileRouter } from './routes/profile.js';
import { automationRouter } from './routes/automation.js';
import { analyticsRouter } from './routes/analytics.js';
import { settingsRouter } from './routes/settings.js';
import { usersRouter } from './routes/users.js';
import { platformsRouter } from './routes/platforms.js';
import { answersRouter } from './routes/answers.js';
import { mockPlatformRouter } from './routes/mockPlatform.js';

export const app = express();

// The API can start logins with stored passwords, so only the app's own UI may call it from a browser
const clientUrls = (env.CLIENT_URL || '')
  .split(',')
  .map((u) => u.trim().replace(/\/+$/, ''))
  .filter(Boolean);

const allowedOrigins = new Set([
  ...clientUrls,
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
]);

const isOriginAllowed = (origin?: string): boolean => {
  if (!origin) return true; // non-browser requests, health checks, curl
  const clean = origin.trim().replace(/\/+$/, '');
  if (allowedOrigins.has('*') || allowedOrigins.has(clean)) return true;
  // Automatically permit *.onrender.com, *.vercel.app, and *.netlify.app for smooth cloud hosting
  if (clean.endsWith('.onrender.com') || clean.endsWith('.vercel.app') || clean.endsWith('.netlify.app')) {
    return true;
  }
  return false;
};

app.use(
  cors({
    origin: (origin, callback) => callback(null, isOriginAllowed(origin)),
    credentials: true,
  })
);

app.use('/api', (req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;
  if (origin && !isOriginAllowed(origin)) {
    res.status(403).json({ success: false, error: `Origin '${origin}' not allowed by CORS. Set CLIENT_URL on Render.` });
    return;
  }
  next();
});
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use((req: Request, _res: Response, next: NextFunction) => {
  if (!req.url.startsWith('/data/')) {
    logger.debug({ method: req.method, url: req.url }, 'Incoming HTTP Request');
  }
  next();
});

// Generated resumes & screenshots
app.use('/data/resumes', express.static(paths.resumesDir));
app.use('/data/screenshots', express.static(paths.screenshotsDir));

app.use('/api/jobs', jobsRouter);
app.use('/api/resumes', resumesRouter);
app.use('/api/applications', applicationsRouter);
app.use('/api/profile', profileRouter);
app.use('/api/automation', automationRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/users', usersRouter);
app.use('/api/platforms', platformsRouter);
app.use('/api/answers', answersRouter);

// Local practice board used for testing the automation end to end
app.use('/mock-portal', mockPlatformRouter);

app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    version: '2.0.0',
    timestamp: new Date().toISOString(),
    automationMode: env.AUTOMATION_MODE,
  });
});

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  logger.error({ err: err.message, stack: err.stack }, 'Unhandled API Error');
  res.status(500).json({
    success: false,
    error: err.message || 'Internal Server Error',
  });
});

if (process.env.NODE_ENV !== 'test') {
  const host = process.env.HOST || '0.0.0.0';
  const server = app.listen(env.PORT, host, async () => {
    logger.info(`AI Job Application Automation Server listening on http://${host}:${env.PORT}`);
    const repo = getRepository();
    await repo.init();
    await scheduler.init();
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutting down server gracefully...');
    scheduler.shutdown();
    await Promise.race([orchestrator.stopAll(), new Promise((r) => setTimeout(r, 10000))]);
    await browserPool.closeAll();
    server.close(() => {
      logger.info('HTTP server closed');
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
