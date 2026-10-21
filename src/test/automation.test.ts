import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import http from 'http';
import request from 'supertest';
import { app } from '../index.js';
import { getRepository } from '../db/client.js';
import { ApplicationStateMachine } from '../queue/stateMachine.js';
import { automationWorker } from '../automation/worker.js';
import { browserPool } from '../automation/browser/browserPool.js';
import { connectionManager } from '../automation/connectionManager.js';
import { sessionStore } from '../automation/security/sessionStore.js';
import { orchestrator } from '../queue/orchestrator.js';
import { scheduler } from '../scheduler/scheduler.js';
import { paths } from '../config/paths.js';
import { DEMO_PLATFORM } from '../db/seed.js';
import { Application, NormalizedJob } from '../types/index.js';
import { testCandidate } from './fixtures.js';

const TEST_PORT = 5099;
const BASE = `http://localhost:${TEST_PORT}/mock-portal`;
const DEMO = encodeURIComponent(DEMO_PLATFORM);
let server: http.Server;
let userId: string;

async function newCandidate(label: string): Promise<string> {
  const repo = getRepository();
  const { user } = await repo.createUser(`${label}-${Date.now()}@testmail.dev`, 'Priya Sharma');
  await repo.updateProfile(user.id, testCandidate(user.id));
  return user.id;
}

async function demoApps(uid: string): Promise<Record<string, Application>> {
  const { applications } = await getRepository().getApplications(uid, { limit: 200 });
  return Object.fromEntries(
    applications.filter((a) => a.job?.platform === DEMO_PLATFORM).map((a) => [a.job!.external_id, a])
  );
}

beforeAll(async () => {
  await getRepository().init();
  server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(TEST_PORT, () => resolve(s));
  });
  userId = await newCandidate('e2e');
  await getRepository().updatePreferences(userId, {
    enabled_platforms: [DEMO_PLATFORM],
    automation_mode: 'production',
    minimum_match_score: 40,
    work_modes: ['Remote', 'Hybrid', 'Onsite'],
    jobs_per_platform: 10,
    per_platform_daily_limit: 20,
    max_applications_per_day: 50,
    search_keywords: [],
  });
});

afterAll(async () => {
  await orchestrator.stopAll();
  await browserPool.closeAll();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('Application state machine', () => {
  it('allows the standard path and re-processing paths', () => {
    const path_ = ['DISCOVERED', 'ANALYZING', 'MATCHED', 'RESUME_GENERATING', 'RESUME_READY', 'APPLICATION_READY', 'APPLYING', 'SUBMITTED'] as const;
    for (let i = 0; i < path_.length - 1; i++) {
      expect(ApplicationStateMachine.isValidTransition(path_[i], path_[i + 1])).toBe(true);
    }
    expect(ApplicationStateMachine.isValidTransition('APPLYING', 'APPLICATION_READY')).toBe(true);
    expect(ApplicationStateMachine.isValidTransition('REQUIRES_HUMAN_ACTION', 'ANALYZING')).toBe(true);
    expect(ApplicationStateMachine.isValidTransition('DISCOVERED', 'SUBMITTED')).toBe(false);
    expect(ApplicationStateMachine.isValidTransition('SUBMITTED', 'APPLYING')).toBe(false);
  });
});

describe('Company career page (single-page form)', () => {
  const legacyJob = async (externalId: string, slug: string): Promise<NormalizedJob> =>
    getRepository().upsertJob({
      external_id: externalId,
      platform: 'Direct Portals',
      title: 'Full Stack Engineer (Node.js & React)',
      company: 'Controlled Test Corp',
      locations: ['Remote'],
      work_mode: 'Remote',
      experience_required: '2-5 years',
      salary: 'Not disclosed',
      description: 'Build features with TypeScript, Node.js, React and PostgreSQL.',
      requirements: [],
      skills: ['TypeScript', 'Node.js', 'React', 'PostgreSQL'],
      application_url: `${BASE}/job/${slug}`,
      is_active: true,
    });

  it('dry run fills every field from the profile and attaches the tailored resume without submitting', async () => {
    const repo = getRepository();
    const job = await legacyJob('e2e-direct-dry', 'unstop-dev-9182');
    const result = await automationWorker.processJob(userId, job, { dryRun: true, manual: true });
    expect(result.status).toBe('APPLICATION_READY');

    const record = (await repo.getApplicationByJob(userId, job.id))!;
    expect(record.status).toBe('APPLICATION_READY');
    expect(record.screenshot_path && fs.existsSync(record.screenshot_path)).toBe(true);
    const resume = (await repo.getResumeVersion(record.resume_version_id!))!;
    expect(resume.job_id).toBe(job.id);
    expect(fs.existsSync(resume.pdf_path!)).toBe(true);
    expect(resume.content_json.experience.map((e) => e.company)).toEqual(['Acme Analytics']);

    const answers = Object.fromEntries((await repo.getQuestions(record.id)).map((q) => [q.question_text, q.answer?.answer_text]));
    expect(answers['Full Name']).toBe('Priya Sharma');
    expect(answers['Email Address']).toBe('priya.sharma@testmail.dev');
    expect(answers['Phone Number']).toBe('+91 98765 43210');
    expect(answers['Years of Relevant Experience']).toBe('4');
    expect(answers['Notice Period']).toBe('30 days');
    expect(answers['Salary Expectations']).toBe('18 LPA');
    expect(JSON.stringify(answers)).not.toMatch(/alexchen|165,000/);
  });

  it('production submits and records a verified submission', async () => {
    const repo = getRepository();
    const job = await legacyJob('e2e-direct-prod', 'unstop-be-7741');
    const result = await automationWorker.processJob(userId, job, { dryRun: false, manual: true });
    expect(result.status).toBe('SUBMITTED');
    const record = (await repo.getApplicationByJob(userId, job.id))!;
    expect(record.submission_verified).toBe(true);
    expect(record.applied_at).toBeTruthy();
  });

  it('pauses for the user when a CAPTCHA is shown, without crashing', async () => {
    const repo = getRepository();
    const job = await legacyJob('e2e-direct-captcha', 'unstop-captcha-demo');
    const result = await automationWorker.processJob(userId, job, { dryRun: false, manual: true });
    expect(result.status).toBe('REQUIRES_HUMAN_ACTION');
    const record = (await repo.getApplicationByJob(userId, job.id))!;
    expect(record.requires_human_reason).toMatch(/reCAPTCHA/i);
  });
});

describe('Platform login: enter the password once', () => {
  it('logs in with the saved password and keeps an encrypted session for later runs', async () => {
    const repo = getRepository();
    const res = await request(app)
      .put(`/api/platforms/${DEMO}/credentials`)
      .set('x-user-id', userId)
      .send({ username: 'priya@demo.dev', password: 'correct-horse' });
    expect(res.status).toBe(200);
    await connectionManager.waitForConnect(userId, DEMO_PLATFORM);

    const cred = (await repo.getCredential(userId, DEMO_PLATFORM))!;
    expect(cred.status).toBe('connected');
    expect(cred.last_verified_at).toBeTruthy();
    expect(await sessionStore.has(userId, DEMO_PLATFORM)).toBe(true);

    const sessionFile = path.join(paths.sessionsDir, userId.replace(/[^a-zA-Z0-9_-]/g, '_'), 'Demo_Portal.session');
    const onDisk = fs.readFileSync(sessionFile, 'utf-8');
    expect(onDisk).not.toContain('demo_session');
    expect(onDisk).not.toContain('correct-horse');

    // A brand-new browser context with the stored session is already signed in
    const context = await browserPool.newContext({ storageState: await sessionStore.load(userId, DEMO_PLATFORM) });
    const page = await context.newPage();
    await page.goto(`${BASE}/account`);
    expect(page.url()).toContain('/account');
    expect(await page.textContent('h1')).toContain('priya@demo.dev');
    await context.close();
  });

  it('reports a wrong password and flags OTP prompts for interactive verification', async () => {
    const repo = getRepository();
    const other = await newCandidate('login');

    await request(app).put(`/api/platforms/${DEMO}/credentials`).set('x-user-id', other).send({ username: 'priya@demo.dev', password: 'wrong' });
    await connectionManager.waitForConnect(other, DEMO_PLATFORM);
    let cred = (await repo.getCredential(other, DEMO_PLATFORM))!;
    expect(cred.status).toBe('failed');
    expect(cred.last_error).toMatch(/Invalid email or password/);

    await request(app).put(`/api/platforms/${DEMO}/credentials`).set('x-user-id', other).send({ username: 'otp-user@demo.dev', password: 'correct-horse' });
    await connectionManager.waitForConnect(other, DEMO_PLATFORM);
    cred = (await repo.getCredential(other, DEMO_PLATFORM))!;
    expect(cred.status).toBe('needs_verification');
    expect(cred.last_error).toMatch(/Connect/);
  });
});

describe('Full automation run on the practice board', () => {
  it('dry run: searches, tailors a resume per job and fills every step without submitting', async () => {
    const res = await request(app).post('/api/automation/run-now').set('x-user-id', userId).send({ dryRun: true });
    expect(res.status).toBe(202);
    await orchestrator.waitForRun(userId);

    const run = (await getRepository().getRuns(userId, 1))[0];
    expect(run.status).toBe('completed');
    expect(run.mode).toBe('dry-run');
    expect(run.platforms?.[DEMO_PLATFORM]?.discovered).toBe(4);

    const apps = await demoApps(userId);
    expect(apps['demo-fullstack-101'].status).toBe('APPLICATION_READY');
    expect(apps['demo-backend-202'].status).toBe('APPLICATION_READY');
    expect(apps['demo-captcha-404'].status).toBe('REQUIRES_HUMAN_ACTION');
    expect(apps['demo-custom-q-303'].status).toBe('REQUIRES_HUMAN_ACTION');
  });

  it('production run submits the prepared applications with verified confirmations', async () => {
    const res = await request(app).post('/api/automation/run-now').set('x-user-id', userId).send({});
    expect(res.status).toBe(202);
    // A second start while running is rejected
    const again = await request(app).post('/api/automation/run-now').set('x-user-id', userId).send({});
    expect(again.status).toBe(409);
    await orchestrator.waitForRun(userId);

    const repo = getRepository();
    const run = (await repo.getRuns(userId, 1))[0];
    expect(run.status).toBe('completed');
    // The two practice-board jobs (older seeded demo jobs on the same board may be submitted too)
    expect(run.applications_submitted).toBeGreaterThanOrEqual(2);

    const apps = await demoApps(userId);
    for (const id of ['demo-fullstack-101', 'demo-backend-202']) {
      expect(apps[id].status).toBe('SUBMITTED');
      expect(apps[id].submission_verified).toBe(true);
      expect(apps[id].submission_receipt?.confirmation_number).toMatch(/^DEMO-[0-9A-F]{6}$/);
      const resume = (await repo.getResumeVersion(apps[id].resume_version_id!))!;
      expect(resume.job_id).toBe(apps[id].job_id);
      expect(fs.existsSync(resume.pdf_path!)).toBe(true);
    }

    const custom = apps['demo-custom-q-303'];
    expect(custom.status).toBe('REQUIRES_HUMAN_ACTION');
    expect(custom.unanswered_questions).toContain('Please enter your HackerRank profile ID');
    expect(apps['demo-captcha-404'].requires_human_reason).toMatch(/CAPTCHA/i);

    const pending = (await repo.getAnswerBank(userId)).find((e) => /HackerRank/.test(e.question));
    expect(pending).toBeDefined();
    expect(pending!.answer).toBeFalsy();
  });

  it('after the user answers the question once, the next run finishes that application and skips finished ones', async () => {
    const repo = getRepository();
    const pending = (await repo.getAnswerBank(userId)).find((e) => /HackerRank/.test(e.question))!;
    const answered = await request(app).put(`/api/answers/${pending.id}`).set('x-user-id', userId).send({ answer: 'priya_codes' });
    expect(answered.status).toBe(200);

    const before = await demoApps(userId);
    await request(app).post('/api/automation/run-now').set('x-user-id', userId).send({});
    await orchestrator.waitForRun(userId);

    const after = await demoApps(userId);
    expect(after['demo-custom-q-303'].status).toBe('SUBMITTED');
    const custom = await request(app).get(`/api/applications/${after['demo-custom-q-303'].id}`).set('x-user-id', userId);
    const hackerrank = custom.body.data.questions.find((q: any) => /HackerRank/.test(q.question_text));
    expect(hackerrank.answer.answer_text).toBe('priya_codes');
    expect(hackerrank.answer.source).toBe('answer_bank');
    // Already-submitted jobs were not applied to again
    expect(after['demo-fullstack-101'].applied_at).toBe(before['demo-fullstack-101'].applied_at);
    expect(after['demo-fullstack-101'].attempt_count).toBe(before['demo-fullstack-101'].attempt_count);
    // CAPTCHA job waits for the user and is not retried automatically
    expect(after['demo-captcha-404'].attempt_count).toBe(before['demo-captcha-404'].attempt_count);
  });
});

describe('Scheduling and recovery', () => {
  it('scheduled runs refuse to apply with an incomplete profile and record why', async () => {
    const repo = getRepository();
    const { user } = await repo.createUser(`sched-${Date.now()}@testmail.dev`, 'Half Done');
    await repo.updatePreferences(user.id, { automation_enabled: true, last_run_at: new Date(0).toISOString() });
    await scheduler.tick();
    const runs = await repo.getRuns(user.id, 5);
    expect(runs[0].status).toBe('failed');
    expect(runs[0].error_message).toMatch(/Complete your profile/);
    await repo.updatePreferences(user.id, { automation_enabled: false });
  });

  it('marks runs and applications interrupted by a restart as failed so they can be retried', async () => {
    const repo = getRepository();
    const uid = await newCandidate('recover');
    const job = await repo.upsertJob({
      external_id: 'recover-1', platform: 'Direct Portals', title: 'Engineer', company: 'X', locations: [], work_mode: 'Remote',
      experience_required: '', salary: '', description: '', requirements: [], skills: [], application_url: `${BASE}/job/x`, is_active: true,
    });
    const appRecord = await repo.createApplication({ user_id: uid, job_id: job.id, status: 'APPLYING' });
    const run = await repo.createRun({ user_id: uid, trigger_type: 'manual', mode: 'dry-run', status: 'running', jobs_scanned: 0, jobs_matched: 0, applications_submitted: 0, applications_failed: 0, human_verification_required: 0 });
    const result = await repo.recoverInterrupted();
    expect(result.runs).toBeGreaterThanOrEqual(1);
    expect((await repo.getApplication(appRecord.id))!.status).toBe('FAILED');
    expect((await repo.getRuns(uid, 1))[0]).toMatchObject({ id: run.id, status: 'failed' });
  });
});
