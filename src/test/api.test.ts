import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { app } from '../index.js';
import { getRepository } from '../db/client.js';
import { testCandidate } from './fixtures.js';

describe('REST API Endpoints', () => {
  beforeAll(async () => {
    await getRepository().init();
  });

  it('GET /health should return 200 ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('GET /api/jobs should return jobs list with matches', async () => {
    const res = await request(app).get('/api/jobs');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
  });

  it('GET /api/jobs?platform= filters by platform', async () => {
    const res = await request(app).get('/api/jobs?platform=Demo%20Portal');
    expect(res.status).toBe(200);
    expect(res.body.data.every((j: any) => j.platform === 'Demo Portal')).toBe(true);
  });

  it('GET /api/jobs/:id should return single job with details', async () => {
    const res = await request(app).get('/api/jobs/job-unstop-001');
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe('job-unstop-001');
    expect(res.body.data.match).toBeDefined();
  });

  it('POST /api/jobs detects the platform from the URL and rejects bad URLs', async () => {
    const ok = await request(app)
      .post('/api/jobs')
      .send({ title: 'Platform Engineer', company: 'Globex', application_url: 'https://job-boards.greenhouse.io/globex/jobs/123', description: 'Kubernetes and Go' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.platform).toBe('Greenhouse');
    expect(ok.body.data.skills).toEqual(expect.arrayContaining(['Kubernetes', 'Go']));
    const bad = await request(app).post('/api/jobs').send({ title: 'X', company: 'Y', application_url: 'javascript:alert(1)' });
    expect(bad.status).toBe(400);
  });

  it('GET /api/resumes/master should return master resume', async () => {
    const res = await request(app).get('/api/resumes/master');
    expect(res.status).toBe(200);
    expect(res.body.data.is_master).toBe(true);
  });

  it('GET /api/profile should return candidate profile', async () => {
    const res = await request(app).get('/api/profile');
    expect(res.status).toBe(200);
    expect(res.body.data.full_name).toBeTruthy();
    expect(res.body.data.skills.length).toBeGreaterThan(0);
  });

  it('POST /api/profile/extract-resume should extract structured profile from text', async () => {
    const res = await request(app)
      .post('/api/profile/extract-resume')
      .send({
        text: 'Ravi Kumar\nravi.kumar@mailbox.dev | +91 91234 56789 | https://github.com/ravik\n\nEXPERIENCE\nSoftware Engineer, Initech 2022 - Present\n- Built APIs in Node.js and TypeScript\n\nEDUCATION\nAnna University\nB.Tech Computer Science 2018 - 2022\n\nSKILLS\nTypeScript, Node.js, React',
      });
    expect(res.status).toBe(200);
    expect(res.body.data.full_name).toBe('Ravi Kumar');
    expect(res.body.data.skills).toEqual(expect.arrayContaining(['TypeScript', 'Node.js', 'React']));
    // Education years must not count as work experience
    expect(res.body.data.years_of_experience).toBeLessThanOrEqual(5);
    expect(res.body.data.github_url).toBe('https://github.com/ravik');
  });

  it('GET /api/analytics/dashboard should return dashboard stats', async () => {
    const res = await request(app).get('/api/analytics/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.data.jobs_found).toBeGreaterThan(0);
  });

  it('GET /api/automation/status and /readiness report state', async () => {
    const status = await request(app).get('/api/automation/status');
    expect(status.status).toBe(200);
    expect(status.body.data.mode).toBeDefined();
    const readiness = await request(app).get('/api/automation/readiness');
    expect(readiness.status).toBe(200);
    // The default seed user has sample (example.com) contact details
    expect(readiness.body.data.profile.ready).toBe(false);
    expect(readiness.body.data.ai_engine).toBe('offline');
  });

  it('POST /api/automation/run-now refuses to apply with a sample profile', async () => {
    const res = await request(app).post('/api/automation/run-now').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Complete your profile/);
  });

  it('GET /mock-portal/job/unstop-dev-9182 renders the application form', async () => {
    const res = await request(app).get('/mock-portal/job/unstop-dev-9182');
    expect(res.status).toBe(200);
    expect(res.text).toContain('application-form');
    expect(res.text).toContain('data-testid="applicant-name"');
  });

  it('GET /api/users lists users and creates isolated ones', async () => {
    const list = await request(app).get('/api/users');
    expect(list.status).toBe(200);
    expect(list.body.data.length).toBeGreaterThan(0);

    const uniqueEmail = `candidate-${Date.now()}@mailbox.dev`;
    const created = await request(app).post('/api/users').send({ email: uniqueEmail, full_name: 'Test New Candidate' });
    expect(created.status).toBe(200);
    expect(created.body.data.profile.full_name).toBe('Test New Candidate');
    const newUserId = created.body.data.user.id;
    const profileRes = await request(app).get('/api/profile').set('x-user-id', newUserId);
    expect(profileRes.body.data.email).toBe(uniqueEmail);
    const prefs = await request(app).get('/api/settings').set('x-user-id', newUserId);
    expect(prefs.body.data.enabled_platforms).toEqual(['Greenhouse', 'Lever', 'Ashby']);
  });
});

describe('Platforms, credentials and answers API', () => {
  let userId: string;

  beforeAll(async () => {
    const repo = getRepository();
    const { user } = await repo.createUser(`api-${Date.now()}@mailbox.dev`, 'Api Tester');
    userId = user.id;
    await repo.updateProfile(userId, testCandidate(userId));
  });

  it('lists the platform catalog with login requirements', async () => {
    const res = await request(app).get('/api/platforms').set('x-user-id', userId);
    expect(res.status).toBe(200);
    const ids = res.body.data.map((p: any) => p.id);
    expect(ids).toEqual(expect.arrayContaining(['LinkedIn', 'Naukri', 'Indeed', 'Unstop', 'Internshala', 'Greenhouse', 'Lever', 'Ashby']));
    const linkedin = res.body.data.find((p: any) => p.id === 'LinkedIn');
    expect(linkedin.requires_login).toBe(true);
    expect(linkedin.connection.status).toBe('not_connected');
    expect(res.body.data.find((p: any) => p.id === 'Greenhouse').requires_login).toBe(false);
    expect(res.body.boards.greenhouse_boards.length).toBeGreaterThan(5);
  });

  it('stores passwords encrypted and never returns them', async () => {
    const save = await request(app)
      .put('/api/platforms/LinkedIn/credentials')
      .set('x-user-id', userId)
      .send({ username: 'priya@mailbox.dev', password: 'Sup3r-Secret!', verify: false });
    expect(save.status).toBe(200);
    expect(JSON.stringify(save.body)).not.toContain('Sup3r-Secret!');
    expect(save.body.data.connection).toMatchObject({ status: 'credentials_saved', username: 'priya@mailbox.dev', has_password: true });

    const stored = await getRepository().getCredential(userId, 'LinkedIn');
    expect(JSON.stringify(stored)).not.toContain('Sup3r-Secret!');

    const list = await request(app).get('/api/platforms').set('x-user-id', userId);
    expect(JSON.stringify(list.body)).not.toContain('Sup3r-Secret!');

    const removed = await request(app).delete('/api/platforms/LinkedIn/credentials').set('x-user-id', userId);
    expect(removed.body.success).toBe(true);
    expect(await getRepository().getCredential(userId, 'LinkedIn')).toBeNull();
  });

  it('enables only known platforms', async () => {
    const res = await request(app)
      .put('/api/platforms/enabled')
      .set('x-user-id', userId)
      .send({ enabled_platforms: ['LinkedIn', 'naukri', 'Wellfound', 'Greenhouse'] });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(['LinkedIn', 'Naukri', 'Greenhouse']);
  });

  it('validates settings updates', async () => {
    const bad = await request(app).put('/api/settings').set('x-user-id', userId).send({ max_applications_per_day: 0 });
    expect(bad.status).toBe(400);
    const good = await request(app)
      .put('/api/settings')
      .set('x-user-id', userId)
      .send({ automation_mode: 'production', user_id: 'someone-else', posted_within_days: 3 });
    expect(good.status).toBe(200);
    expect(good.body.data.user_id).toBe(userId);
    expect(good.body.data.posted_within_days).toBe(3);
  });

  it('manages the screening answer bank', async () => {
    const created = await request(app)
      .post('/api/answers')
      .set('x-user-id', userId)
      .send({ question: 'Are you comfortable working night shifts?', answer: 'No' });
    expect(created.status).toBe(200);
    const list = await request(app).get('/api/answers').set('x-user-id', userId);
    expect(list.body.data.some((e: any) => e.answer === 'No')).toBe(true);
    const updated = await request(app).put(`/api/answers/${created.body.data.id}`).set('x-user-id', userId).send({ answer: 'Yes' });
    expect(updated.body.data.answer).toBe('Yes');
    const otherUser = await request(app).put(`/api/answers/${created.body.data.id}`).send({ answer: 'hijack' });
    expect(otherUser.status).toBe(404);
  });

  it('rejects API calls from foreign websites', async () => {
    const res = await request(app).post('/api/automation/run-now').set('Origin', 'https://evil.example').send({});
    expect(res.status).toBe(403);
    const allowed = await request(app).get('/api/platforms').set('Origin', 'http://localhost:5173');
    expect(allowed.status).toBe(200);
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });
});

describe('Manual profile editing', () => {
  let userId: string;

  beforeAll(async () => {
    const { user } = await getRepository().createUser(`manual-${Date.now()}@mailbox.dev`, 'Manual Tester');
    userId = user.id;
  });

  it('saves a profile typed by hand, drops empty rows and keeps the master resume in sync', async () => {
    const res = await request(app)
      .put('/api/profile')
      .set('x-user-id', userId)
      .send({
        id: 'should-be-ignored',
        user_id: 'someone-else',
        full_name: '  Asha Verma ',
        email: 'asha.verma@mailbox.dev',
        phone: '+91 91234 56789',
        location: 'Pune, Maharashtra, India',
        professional_summary: 'Frontend developer building React apps.',
        years_of_experience: '2',
        notice_period_days: 30,
        preferred_roles: ['React Developer', '', ' Frontend Engineer '],
        languages: ['English', ''],
        gender: 'Female',
        skills: [
          { name: 'React', category: 'Framework', proficiency: 'Advanced', years_experience: 2 },
          { name: 'react', category: 'Framework', proficiency: 'Advanced', years_experience: 2 },
          { name: 'JavaScript', category: 'Technical', proficiency: 'Advanced', years_experience: '2' },
          { name: 'CSS', category: 'Unknown', proficiency: 'Guru', years_experience: 'x' },
        ],
        experience: [
          { company: 'Acme', role: 'Frontend Developer', start_date: '2023-01', is_current: true, end_date: '2024-01', bullets: ['Built the dashboard', ''], technologies: ['React', ''] },
          { company: '', role: '', start_date: '', is_current: false, bullets: [], technologies: [] },
        ],
        education: [{ institution: 'Pune University', degree: 'B.E.', field_of_study: 'IT', start_year: '2018', end_year: 2022 }],
        projects: [{ title: 'Portfolio', description: 'Personal site', technologies: ['React'], bullets: [] }, { title: '', description: '' }],
        certifications: ['Meta Front-End Developer', ''],
      });
    expect(res.status).toBe(200);
    const p = res.body.data;
    expect(p.user_id).toBe(userId);
    expect(p.full_name).toBe('Asha Verma');
    expect(p.years_of_experience).toBe(2);
    expect(p.preferred_roles).toEqual(['React Developer', 'Frontend Engineer']);
    expect(p.languages).toEqual(['English']);
    expect(p.skills.map((s: any) => s.name)).toEqual(['React', 'JavaScript', 'CSS']);
    expect(p.skills[2]).toMatchObject({ category: 'Technical', proficiency: 'Intermediate', years_experience: 0 });
    expect(p.experience).toHaveLength(1);
    expect(p.experience[0]).toMatchObject({ company: 'Acme', is_current: true, bullets: ['Built the dashboard'], technologies: ['React'] });
    expect(p.experience[0].end_date).toBeUndefined();
    expect(p.education[0]).toMatchObject({ institution: 'Pune University', start_year: 2018, end_year: 2022 });
    expect(p.projects.map((x: any) => x.title)).toEqual(['Portfolio']);
    expect(p.certifications).toEqual(['Meta Front-End Developer']);

    // Persisted, and the master resume used for tailoring reflects the manual entries
    const again = await request(app).get('/api/profile').set('x-user-id', userId);
    expect(again.body.data.experience[0].company).toBe('Acme');
    const master = await request(app).get('/api/resumes/master').set('x-user-id', userId);
    expect(master.body.data.content_json.experience[0]).toMatchObject({ company: 'Acme', role: 'Frontend Developer', period: 'Jan 2023 - Present' });
    expect(master.body.data.content_json.skills.flatMap((g: any) => g.items)).toEqual(expect.arrayContaining(['React', 'JavaScript', 'CSS']));
    expect(master.body.data.content_json.education[0].degree).toBe('B.E. in IT');

    // Profile is now complete enough for automation
    const readiness = await request(app).get('/api/profile/readiness').set('x-user-id', userId);
    expect(readiness.body.data.ready).toBe(true);
  });

  it('clears an optional field and rejects an invalid email', async () => {
    const cleared = await request(app).put('/api/profile').set('x-user-id', userId).send({ gender: '' });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data.gender).toBeUndefined();
    expect(cleared.body.data.full_name).toBe('Asha Verma');

    const bad = await request(app).put('/api/profile').set('x-user-id', userId).send({ email: 'not-an-email' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/email/i);
  });
});
