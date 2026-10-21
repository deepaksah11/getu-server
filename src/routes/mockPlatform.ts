import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import multer from 'multer';
import { getRepository } from '../db/client.js';
import { DEMO_BASE_URL, DEMO_PLATFORM } from '../db/seed.js';

/**
 * Practice board for exercising the automation end to end without contacting
 * a real employer: login with a session cookie, a job search API, a multi-step
 * "Easy Apply" form with validation, and a CAPTCHA variant.
 * Demo login: any email + password "correct-horse" (an email containing "otp" triggers a code prompt).
 */
export const mockPlatformRouter = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const DEMO_PASSWORD = 'correct-horse';
const sessions = new Map<string, { username: string; applied: Set<string> }>();

const DEMO_JOBS = [
  {
    id: 'demo-fullstack-101',
    title: 'Full Stack Engineer (Node.js & React)',
    company: 'Demo Labs',
    skills: ['TypeScript', 'Node.js', 'React', 'PostgreSQL'],
    description:
      'Build product features end to end with TypeScript, Node.js and React. Design PostgreSQL schemas and REST APIs. 3+ years of experience. Remote friendly.',
  },
  {
    id: 'demo-backend-202',
    title: 'Backend Engineer (Node.js)',
    company: 'Sample Systems',
    skills: ['Node.js', 'TypeScript', 'Redis', 'Docker'],
    description: 'Own backend services in Node.js and TypeScript, caching with Redis, deployments with Docker. 2+ years of experience.',
  },
  {
    id: 'demo-custom-q-303',
    title: 'Software Engineer, Platform',
    company: 'Practice Corp',
    skills: ['TypeScript', 'Node.js', 'System Design'],
    description: 'Platform engineering with TypeScript and Node.js. Applicants answer a company-specific question.',
  },
  {
    id: 'demo-captcha-404',
    title: 'Senior Software Engineer (Verification Demo)',
    company: 'Shielded Inc',
    skills: ['TypeScript', 'System Design'],
    description: 'Shows a CAPTCHA during the application to demonstrate the pause-for-human flow.',
  },
];

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sessionOf(req: Request) {
  const cookie = req.headers.cookie || '';
  const token = cookie.match(/(?:^|;\s*)demo_session=([a-f0-9]+)/)?.[1];
  return token ? sessions.get(token) : undefined;
}

function page(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: -apple-system, 'Segoe UI', Roboto, sans-serif; background: #f8fafc; color: #1e293b; padding: 40px; margin: 0; }
    .container { max-width: 680px; margin: 0 auto; background: #fff; padding: 32px; border-radius: 8px; border: 1px solid #e2e8f0; }
    h1 { font-size: 22px; margin-top: 0; }
    .form-group { margin-bottom: 16px; }
    label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; }
    input[type="text"], input[type="email"], input[type="tel"], input[type="password"], textarea, select { width: 100%; box-sizing: border-box; padding: 9px 11px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 14px; }
    button { background: #0284c7; color: #fff; border: none; padding: 10px 20px; font-size: 14px; font-weight: 600; border-radius: 6px; cursor: pointer; }
    .error, .field-error { color: #b91c1c; font-size: 13px; margin-top: 4px; }
    .step { display: none; } .step.active { display: block; }
    .captcha-box { background: #fef2f2; border: 1px solid #fecaca; border-radius: 6px; padding: 16px; margin: 16px 0; }
  </style>
</head>
<body><div class="container">${body}</div></body>
</html>`;
}

// --- Login -------------------------------------------------------------------
mockPlatformRouter.get('/login', (req: Request, res: Response) => {
  const next = typeof req.query.next === 'string' ? req.query.next : '/mock-portal/account';
  res.send(
    page(
      'Demo Board - Sign in',
      `<h1>Sign in to Demo Board</h1>
      ${req.query.error ? '<p class="error">Invalid email or password</p>' : ''}
      <form method="POST" action="/mock-portal/login">
        <input type="hidden" name="next" value="${escapeHtml(next)}">
        <div class="form-group"><label for="username">Email</label><input type="email" id="username" name="username" required></div>
        <div class="form-group"><label for="password">Password</label><input type="password" id="password" name="password" required></div>
        <button type="submit">Sign in</button>
      </form>`
    )
  );
});

mockPlatformRouter.post('/login', (req: Request, res: Response) => {
  const { username, password } = req.body || {};
  const next = typeof req.body?.next === 'string' && req.body.next.startsWith('/mock-portal/') ? req.body.next : '/mock-portal/account';
  if (!username || password !== DEMO_PASSWORD) {
    return res.redirect(`/mock-portal/login?error=1&next=${encodeURIComponent(next)}`);
  }
  if (String(username).includes('otp')) {
    return res.redirect('/mock-portal/verify');
  }
  const token = crypto.randomBytes(16).toString('hex');
  sessions.set(token, { username: String(username), applied: new Set() });
  res.setHeader('Set-Cookie', `demo_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
  res.redirect(next);
});

mockPlatformRouter.get('/verify', (_req: Request, res: Response) => {
  res.send(
    page(
      'Demo Board - Verification',
      `<h1>Verify it's you</h1><p>Enter the code we sent to your email.</p>
      <div class="form-group"><label for="otp">Verification code</label><input type="text" id="otp" name="otp" autocomplete="one-time-code"></div>`
    )
  );
});

mockPlatformRouter.get('/account', (req: Request, res: Response) => {
  const session = sessionOf(req);
  if (!session) return res.redirect('/mock-portal/login?next=/mock-portal/account');
  res.send(page('Demo Board - Account', `<h1>Signed in as ${escapeHtml(session.username)}</h1>`));
});

// --- Job search API ---------------------------------------------------------------
mockPlatformRouter.get('/api/jobs', (_req: Request, res: Response) => {
  res.json({
    jobs: DEMO_JOBS.map((j) => ({
      external_id: j.id,
      platform: DEMO_PLATFORM,
      title: j.title,
      company: j.company,
      locations: ['Remote'],
      work_mode: 'Remote',
      experience_required: '2+ years',
      salary: 'Not disclosed',
      description: j.description,
      requirements: [],
      skills: j.skills,
      application_url: `${DEMO_BASE_URL}/apply/${j.id}`,
      posted_at: new Date().toISOString(),
      is_active: true,
    })),
  });
});

// --- Multi-step application ----------------------------------------------------------
mockPlatformRouter.get('/apply/:id', (req: Request, res: Response) => {
  const session = sessionOf(req);
  if (!session) return res.redirect(`/mock-portal/login?next=${encodeURIComponent(req.originalUrl)}`);
  const job = DEMO_JOBS.find((j) => j.id === req.params.id);
  if (!job) return res.status(404).send(page('Not found', '<h1>Job not found</h1>'));
  if (session.applied.has(job.id)) {
    return res.send(page(job.title, `<h1>${escapeHtml(job.title)}</h1><p>You already applied to this job.</p>`));
  }
  const captcha = job.id.includes('captcha');
  const customQuestion = job.id.includes('custom-q');

  res.send(
    page(
      `${job.title} - ${job.company}`,
      `<h1>${escapeHtml(job.title)}</h1>
      <p>${escapeHtml(job.company)} &bull; Remote</p>
      <p>${escapeHtml(job.description)}</p>
      <button id="easy-apply" type="button" onclick="document.getElementById('apply-modal').style.display='block'">Easy Apply</button>
      <div id="apply-modal" role="dialog" style="display:none; margin-top:24px; border-top:1px solid #e2e8f0; padding-top:16px">
        <form id="apply-form" method="POST" action="/mock-portal/apply/${escapeHtml(job.id)}" enctype="multipart/form-data">
          <div class="step active" data-step="1">
            <h2>Contact info</h2>
            <div class="form-group"><label for="first_name">First name *</label><input type="text" id="first_name" name="first_name" required></div>
            <div class="form-group"><label for="last_name">Last name *</label><input type="text" id="last_name" name="last_name" required></div>
            <div class="form-group"><label for="email">Email address *</label><input type="email" id="email" name="email" required></div>
            <div class="form-group"><label for="phone">Mobile phone number *</label><input type="tel" id="phone" name="phone" required></div>
            <div class="form-group"><label for="resume">Upload resume *</label><input type="file" id="resume" name="resume" accept=".pdf,.docx" required></div>
            ${captcha ? '<div class="captcha-box"><strong>Security check</strong><div class="g-recaptcha" style="width:304px;height:78px;border:1px solid #ccc">I\'m not a robot</div></div>' : ''}
            <button type="button" class="next">Next</button>
          </div>
          <div class="step" data-step="2">
            <h2>Additional questions</h2>
            <div class="form-group"><label for="ts-years-numeric">How many years of work experience do you have with TypeScript? *</label><input type="text" id="ts-years-numeric" name="ts_years" required></div>
            <fieldset class="form-group"><legend>Are you legally authorized to work in this country? *</legend>
              <label><input type="radio" name="authorized" value="Yes" required> Yes</label>
              <label><input type="radio" name="authorized" value="No"> No</label>
            </fieldset>
            <div class="form-group"><label for="notice">Notice period *</label>
              <select id="notice" name="notice" required>
                <option value="">Select an option</option><option>Immediately</option><option>15 days or less</option><option>1 month</option><option>2 months</option><option>3 months</option>
              </select></div>
            ${customQuestion ? '<div class="form-group"><label for="hackerrank">Please enter your HackerRank profile ID *</label><input type="text" id="hackerrank" name="hackerrank" required></div>' : ''}
            <button type="button" class="next">Review</button>
          </div>
          <div class="step" data-step="3">
            <h2>Review your application</h2>
            <p>Check your answers, then submit.</p>
            <button type="submit">Submit application</button>
          </div>
        </form>
      </div>
      <script>
        document.querySelectorAll('.next').forEach(function (btn) {
          btn.addEventListener('click', function () {
            var step = btn.closest('.step');
            var ok = true;
            step.querySelectorAll('.field-error').forEach(function (e) { e.remove(); });
            step.querySelectorAll('[required]').forEach(function (input) {
              var empty = input.type === 'radio'
                ? !step.querySelector('input[name="' + input.name + '"]:checked')
                : input.type === 'file' ? !input.files.length : !String(input.value).trim();
              if (input.id === 'ts-years-numeric' && !/^\\d+$/.test(input.value.trim())) empty = true;
              if (empty) {
                ok = false;
                input.setAttribute('aria-invalid', 'true');
                var err = document.createElement('div');
                err.className = 'field-error';
                err.textContent = 'Please enter a valid answer';
                (input.closest('.form-group') || input.parentElement).appendChild(err);
              } else {
                input.removeAttribute('aria-invalid');
              }
            });
            if (ok) {
              step.classList.remove('active');
              step.nextElementSibling.classList.add('active');
            }
          });
        });
      </script>`
    )
  );
});

mockPlatformRouter.post('/apply/:id', upload.single('resume'), (req: Request, res: Response) => {
  const session = sessionOf(req);
  const job = DEMO_JOBS.find((j) => j.id === req.params.id);
  if (!session || !job) return res.status(403).send(page('Error', '<h1>Session expired</h1>'));
  const missing = ['first_name', 'last_name', 'email', 'phone', 'ts_years', 'authorized', 'notice'].filter((f) => !String(req.body?.[f] || '').trim());
  if (!req.file) missing.push('resume');
  if (missing.length) {
    return res.status(400).send(page('Error', `<h1>Application incomplete</h1><p class="error">Missing: ${escapeHtml(missing.join(', '))}</p>`));
  }
  session.applied.add(job.id);
  const confirmation = `DEMO-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  res.send(
    page(
      'Application sent',
      `<h1>Your application was sent to ${escapeHtml(job.company)}</h1><p>Confirmation number: ${confirmation}</p>`
    )
  );
});

// --- Legacy single-page form (kept for older demo jobs and the generic filler test) ---------
mockPlatformRouter.get('/job/:id', async (req: Request, res: Response) => {
  try {
    const jobId = req.params.id;
    const repo = getRepository();
    const job = (await repo.getJobs({ limit: 1000 })).jobs.find((j) => j.external_id === jobId || j.id === jobId);
    const title = job ? job.title : 'Software Engineer';
    const company = job ? job.company : 'Tech Innovations Corp';
    const isCaptchaDemo = jobId.includes('captcha');

    res.send(
      page(
        `${title} - ${company} Application`,
        `<h1>${escapeHtml(title)}</h1>
        <div class="company">${escapeHtml(company)} &bull; Verified Job Application</div>
        <form id="application-form" method="POST" action="/mock-portal/submit">
          <input type="hidden" name="jobId" value="${escapeHtml(jobId)}">
          <div class="form-group"><label for="fullName">Full Name *</label><input type="text" id="fullName" name="fullName" data-testid="applicant-name" placeholder="Your full name" required></div>
          <div class="form-group"><label for="email">Email Address *</label><input type="email" id="email" name="email" data-testid="applicant-email" placeholder="you@example.com" required></div>
          <div class="form-group"><label for="phone">Phone Number *</label><input type="tel" id="phone" name="phone" data-testid="applicant-phone" required></div>
          <div class="form-group"><label for="location">Current Location *</label><input type="text" id="location" name="location" data-testid="applicant-location" required></div>
          <div class="form-group"><label for="experience">Years of Relevant Experience *</label><input type="text" id="experience" name="experience" data-testid="applicant-experience" required></div>
          <div class="form-group"><label for="notice">Notice Period *</label><input type="text" id="notice" name="notice" data-testid="applicant-notice" required></div>
          <div class="form-group"><label for="salary">Salary Expectations *</label><input type="text" id="salary" name="salary" data-testid="applicant-salary" required></div>
          <div class="form-group"><label for="resume">Upload Resume (PDF/DOCX) *</label><input type="file" id="resume" name="resume" data-testid="resume-upload-input" accept=".pdf,.docx" required></div>
          <div class="form-group"><label for="summary">Brief Motivation / Summary</label><textarea id="summary" name="summary" rows="3" data-testid="applicant-summary"></textarea></div>
          ${
            isCaptchaDemo
              ? `<div class="captcha-box"><strong>Security Verification Challenge</strong>
                 <p>Please complete the security challenge below to verify you are human.</p>
                 <div class="g-recaptcha" data-sitekey="demo"><iframe src="https://www.google.com/recaptcha/api2/anchor?k=mock-key" width="304" height="78" role="presentation" frameborder="0"></iframe></div></div>`
              : ''
          }
          <div style="margin-top: 24px;"><button type="submit" class="btn-submit" data-testid="submit-application">Submit Application</button></div>
        </form>`
      )
    );
  } catch (err: any) {
    res.status(500).send(page('Error', `<h1>Unable to load job</h1><p>${escapeHtml(err?.message || 'Error')}</p>`));
  }
});

mockPlatformRouter.post('/submit', (_req: Request, res: Response) => {
  const confirmationNumber = `APP-CONF-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  res.send(page('Application Submitted', `<h1>Application Submitted!</h1><p>Thank you for applying. Your reference is <strong>${confirmationNumber}</strong></p>`));
});
