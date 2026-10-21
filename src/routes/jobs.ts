import { Router, Request, Response } from 'express';
import { getRepository } from '../db/client.js';
import { getUserId } from '../utils/auth.js';
import { matchingEngine } from '../matching/matchingEngine.js';
import { aiService } from '../ai/aiService.js';
import { orchestrator } from '../queue/orchestrator.js';
import { adapterForUrl } from '../automation/platforms/registry.js';
import { extractSkillsFromText } from '../ai/skillDictionary.js';
import { liveJobSearchService, VERIFIED_LIVE_DRIVES_AND_JOBS } from '../automation/liveSearch/liveSearchService.js';
import { logger } from '../config/logger.js';
import { LiveJobFilterOptions, ApplicationStatus } from '../types/index.js';

export const jobsRouter = Router();

// Helper to parse comma-separated or array query params
function parseListParam(param: any): string[] | undefined {
  if (!param) return undefined;
  if (Array.isArray(param)) return param.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof param === 'string') {
    return param
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return undefined;
}

// GET /api/jobs/sources - Get list of integrated sources and career portals
jobsRouter.get('/sources', async (_req: Request, res: Response) => {
  try {
    const sources = liveJobSearchService.getSources();
    res.json({ success: true, data: sources });
  } catch (err: any) {
    logger.error({ err: err.message }, 'Failed fetching sources');
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/jobs/export - Export filtered jobs as CSV or JSON
jobsRouter.get('/export', async (req: Request, res: Response) => {
  try {
    const repo = getRepository();
    const format = (req.query.format as string) === 'json' ? 'json' : 'csv';

    const filterOptions: LiveJobFilterOptions = {
      keyword: req.query.keyword as string | undefined,
      locations: parseListParam(req.query.locations) || (req.query.location ? [String(req.query.location)] : undefined),
      work_modes: parseListParam(req.query.work_modes) || (req.query.work_mode ? [String(req.query.work_mode)] : undefined),
      experience_level: req.query.experience_level as any,
      only_freshers: req.query.only_freshers === 'true',
      only_bulk_hiring: req.query.only_bulk_hiring === 'true',
      platforms: parseListParam(req.query.platforms) || (req.query.platform ? [String(req.query.platform)] : undefined),
      verification_status: req.query.verification_status as any,
      limit: 1000,
    };

    const { jobs } = await repo.getJobs(filterOptions);

    if (format === 'json') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', 'attachment; filename="jobs_export.json"');
      return res.send(JSON.stringify(jobs, null, 2));
    }

    // CSV Format
    const headers = [
      'Title',
      'Company',
      'Locations',
      'Work Mode',
      'Experience Required',
      'Salary',
      'Recruitment Type',
      'Verification Status',
      'Skills',
      'Education',
      'Application URL',
      'Posted Date',
    ];

    const escapeCsv = (val: any) => `"${String(val ?? '').replace(/"/g, '""')}"`;

    const rows = jobs.map((j) => [
      escapeCsv(j.title),
      escapeCsv(j.company),
      escapeCsv(j.locations.join(', ')),
      escapeCsv(j.work_mode),
      escapeCsv(j.experience_required),
      escapeCsv(j.salary),
      escapeCsv(j.recruitment_type || 'regular'),
      escapeCsv(j.verification_status || 'verified_live'),
      escapeCsv(j.skills.join(', ')),
      escapeCsv((j.education_required || []).join(', ')),
      escapeCsv(j.application_url),
      escapeCsv(j.posted_at || j.created_at),
    ]);

    const csvContent = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="jobs_export.csv"');
    return res.send(csvContent);
  } catch (err: any) {
    logger.error({ err: err.message }, 'Failed exporting jobs');
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/jobs - List with unified advanced filters, freshness, de-duplication, bookmarks, and match scores
jobsRouter.get('/', async (req: Request, res: Response) => {
  try {
    const repo = getRepository();
    const userId = getUserId(req);

    const filterOptions: LiveJobFilterOptions = {
      keyword: req.query.keyword as string | undefined,
      excluded_keywords: parseListParam(req.query.excluded_keywords),
      locations: parseListParam(req.query.locations) || (req.query.location ? [String(req.query.location)] : undefined),
      work_modes: parseListParam(req.query.work_modes) || (req.query.work_mode ? [String(req.query.work_mode)] : undefined),
      experience_level: req.query.experience_level as any,
      min_experience: req.query.min_experience ? parseInt(String(req.query.min_experience), 10) : undefined,
      max_experience: req.query.max_experience ? parseInt(String(req.query.max_experience), 10) : undefined,
      min_salary: req.query.min_salary ? parseInt(String(req.query.min_salary), 10) : undefined,
      max_salary: req.query.max_salary ? parseInt(String(req.query.max_salary), 10) : undefined,
      job_types: parseListParam(req.query.job_types),
      roles: parseListParam(req.query.roles),
      technologies: parseListParam(req.query.technologies),
      education: parseListParam(req.query.education),
      company_name: req.query.company_name as string | undefined,
      recruitment_types: parseListParam(req.query.recruitment_types),
      posted_within_days: req.query.posted_within_days ? parseInt(String(req.query.posted_within_days), 10) : undefined,
      platforms: parseListParam(req.query.platforms) || (req.query.platform ? [String(req.query.platform)] : undefined),
      verification_status: req.query.verification_status as any,
      only_freshers: req.query.only_freshers === 'true',
      only_bulk_hiring: req.query.only_bulk_hiring === 'true',
      only_bookmarked: req.query.only_bookmarked === 'true',
      sort_by: req.query.sort_by as any,
      limit: req.query.limit ? parseInt(String(req.query.limit), 10) : 50,
      offset: req.query.offset ? parseInt(String(req.query.offset), 10) : 0,
    };

    const [{ jobs, total }, matches, bookmarks, userApps] = await Promise.all([
      repo.getJobs(filterOptions),
      repo.getMatches(userId),
      repo.getBookmarks(userId),
      repo.getApplications(userId, { limit: 500 }),
    ]);

    const bookmarkSet = new Set(bookmarks);
    const appMap = new Map(userApps.applications.map((a) => [a.job_id, a]));

    let jobsWithMetadata = jobs.map((job) => {
      const match = matches.find((m) => m.job_id === job.id);
      const app = appMap.get(job.id);
      return {
        ...job,
        match: match || null,
        is_bookmarked: bookmarkSet.has(job.id),
        application_status: app?.status,
        candidate_notes: app?.requires_human_reason || undefined,
        application: app || null,
      };
    });

    if (filterOptions.only_bookmarked) {
      jobsWithMetadata = jobsWithMetadata.filter((j) => j.is_bookmarked);
    }

    res.json({
      success: true,
      data: jobsWithMetadata,
      pagination: { total, limit: filterOptions.limit, offset: filterOptions.offset },
    });
  } catch (err: any) {
    logger.error({ err: err.message }, 'Failed fetching live jobs');
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/jobs/live-search - Trigger on-demand multi-source search
jobsRouter.post('/live-search', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const repo = getRepository();
    const profile = await repo.getProfile(userId);
    const platforms = Array.isArray(req.body?.platforms) ? (req.body.platforms as string[]) : undefined;

    logger.info({ userId, platforms }, 'Initiating on-demand live multi-source job search');

    // 1. Run discovery across active platform adapters
    const scanResults = await orchestrator.discover(userId, platforms);
    const scanned = scanResults.reduce((sum, r) => sum + r.found, 0);

    // 2. Ensure verified drives & company career listings are refreshed
    for (const drive of VERIFIED_LIVE_DRIVES_AND_JOBS) {
      if (drive.title && drive.company && drive.application_url) {
        const saved = await repo.upsertJob({
          external_id: drive.external_id || `live-${Date.now()}`,
          platform: drive.platform || 'BulkDrives',
          title: drive.title,
          company: drive.company,
          company_logo: drive.company_logo,
          locations: drive.locations || ['Delhi NCR', 'Noida', 'Gurugram', 'Remote'],
          work_mode: drive.work_mode || 'Hybrid',
          experience_required: drive.experience_required || 'Fresher (0 - 1 Yr)',
          min_experience_years: drive.min_experience_years ?? 0,
          max_experience_years: drive.max_experience_years ?? 1,
          salary: drive.salary || 'Competitive',
          min_salary: drive.min_salary,
          max_salary: drive.max_salary,
          salary_currency: drive.salary_currency || 'INR',
          job_type: drive.job_type || 'full_time',
          recruitment_type: drive.recruitment_type || 'bulk_hiring',
          is_bulk_hiring: drive.is_bulk_hiring ?? true,
          walk_in_details: drive.walk_in_details,
          education_required: drive.education_required || ['BCA', 'B.Tech', 'MCA'],
          description: drive.description || '',
          requirements: drive.requirements || [],
          skills: drive.skills || [],
          application_url: drive.application_url,
          application_deadline: drive.application_deadline,
          posted_at: drive.posted_at || new Date().toISOString(),
          is_active: true,
          verification_status: drive.verification_status || 'verified_live',
          last_verified_at: new Date().toISOString(),
          verification_details: drive.verification_details,
          sources: drive.sources,
          apply_mode: drive.apply_mode || 'direct_automated',
          industry: drive.industry,
          company_size: drive.company_size,
        });
        await repo.saveMatch(matchingEngine.calculateMatch(profile, saved));
      }
    }

    res.json({
      success: true,
      scanned,
      scanResults,
      message: `Live search complete. Discovered ${scanned} jobs across platforms and refreshed live company drives.`,
    });
  } catch (err: any) {
    logger.error({ err: err.message }, 'Failed live search');
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/jobs/:id/verify - Live freshness & link check for a job
jobsRouter.post('/:id/verify', async (req: Request, res: Response) => {
  try {
    const repo = getRepository();
    const job = await repo.getJob(req.params.id);
    if (!job) {
      return res.status(404).json({ success: false, error: 'Job not found' });
    }

    const verification = await liveJobSearchService.verifyJobFreshness(job);

    const updated = await repo.updateJob(job.id, {
      verification_status: verification.status,
      last_verified_at: verification.last_verified_at,
      is_active: verification.status !== 'closed' && verification.status !== 'expired',
      verification_details: {
        http_status: verification.http_status,
        checked_at: verification.last_verified_at,
        message: verification.message,
        is_accessible: verification.status === 'verified_live',
      },
    });

    res.json({
      success: true,
      verification,
      data: updated,
    });
  } catch (err: any) {
    logger.error({ err: err.message }, 'Failed verifying job freshness');
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/jobs/:id/bookmark - Bookmark / Shortlist a job
jobsRouter.post('/:id/bookmark', async (req: Request, res: Response) => {
  try {
    const repo = getRepository();
    const userId = getUserId(req);
    const { notes } = req.body || {};
    const success = await repo.bookmarkJob(userId, req.params.id, notes);
    res.json({ success, bookmarked: true, message: 'Job bookmarked to shortlist.' });
  } catch (err: any) {
    logger.error({ err: err.message }, 'Failed bookmarking job');
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/jobs/:id/bookmark - Remove bookmark
jobsRouter.delete('/:id/bookmark', async (req: Request, res: Response) => {
  try {
    const repo = getRepository();
    const userId = getUserId(req);
    const success = await repo.unbookmarkJob(userId, req.params.id);
    res.json({ success, bookmarked: false, message: 'Job removed from shortlist.' });
  } catch (err: any) {
    logger.error({ err: err.message }, 'Failed removing bookmark');
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/jobs/:id/track-application - Update manual application tracking status and notes
jobsRouter.post('/:id/track-application', async (req: Request, res: Response) => {
  try {
    const repo = getRepository();
    const userId = getUserId(req);
    const { status, notes } = req.body;

    const job = await repo.getJob(req.params.id);
    if (!job) {
      return res.status(404).json({ success: false, error: 'Job not found' });
    }

    let application = await repo.getApplicationByJob(userId, job.id);
    if (application) {
      application = await repo.updateApplication(application.id, {
        status: status || application.status,
        requires_human_reason: notes !== undefined ? notes : application.requires_human_reason,
      });
    } else {
      application = await repo.createApplication({
        user_id: userId,
        job_id: job.id,
        platform: job.platform,
        status: (status as ApplicationStatus) || 'MATCHED',
        requires_human_reason: notes,
      });
    }

    res.json({
      success: true,
      data: application,
      message: 'Application tracking status updated successfully.',
    });
  } catch (err: any) {
    logger.error({ err: err.message }, 'Failed tracking application');
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/jobs - Manually add or import a job by URL
jobsRouter.post('/', async (req: Request, res: Response) => {
  try {
    const repo = getRepository();
    const {
      title,
      company,
      application_url,
      description,
      skills,
      locations,
      work_mode,
      salary,
      experience_required,
      platform,
      education_required,
      job_type,
      recruitment_type,
    } = req.body;

    if (!title || !company || !application_url) {
      return res.status(400).json({
        success: false,
        error: 'Job Title, Company, and Application URL are required.',
      });
    }

    const url = String(application_url).trim();
    if (!/^https?:\/\//i.test(url)) {
      return res.status(400).json({ success: false, error: 'Application URL must start with http:// or https://' });
    }
    const detected = adapterForUrl(url);
    const skillList = Array.isArray(skills)
      ? skills
      : typeof skills === 'string'
      ? skills.split(',').map((s: string) => s.trim()).filter(Boolean)
      : extractSkillsFromText(String(description || ''));

    const eduList = Array.isArray(education_required)
      ? education_required
      : typeof education_required === 'string'
      ? education_required.split(',').map((e: string) => e.trim()).filter(Boolean)
      : ['Any Graduate'];

    const newJob = await repo.upsertJob({
      external_id: `user-${Date.now()}`,
      platform: platform || detected.id,
      title: String(title).trim(),
      company: String(company).trim(),
      locations: Array.isArray(locations) ? locations : [locations || 'Remote'],
      work_mode: work_mode || 'Remote',
      experience_required: experience_required || 'Not specified',
      salary: salary || 'Competitive',
      description: description || `Target opportunity for ${title} at ${company}.`,
      requirements: [],
      skills: skillList,
      education_required: eduList,
      job_type: job_type || 'full_time',
      recruitment_type: recruitment_type || 'regular',
      application_url: url,
      posted_at: new Date().toISOString(),
      is_active: true,
      verification_status: 'verified_live',
      last_verified_at: new Date().toISOString(),
      sources: [{ platform: platform || detected.id, url, is_verified: true }],
    });

    const userId = getUserId(req);
    const profile = await repo.getProfile(userId);
    const matchData = matchingEngine.calculateMatch(profile, newJob);
    const match = await repo.saveMatch(matchData);

    res.json({
      success: true,
      data: {
        ...newJob,
        match,
      },
      message: 'Job opportunity created successfully!',
    });
  } catch (err: any) {
    logger.error({ err: err.message }, 'Failed creating custom job');
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/jobs/scan - Discover new jobs via platform adapters
jobsRouter.post('/scan', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const platforms = Array.isArray(req.body?.platforms) ? (req.body.platforms as string[]) : undefined;
    logger.info({ userId, platforms }, 'Starting job discovery scan');
    const results = await orchestrator.discover(userId, platforms);
    const scanned = results.reduce((sum, r) => sum + r.found, 0);
    const summary = results
      .map((r) => (r.error ? `${r.platform}: failed (${r.error})` : r.skipped ? `${r.platform}: during runs` : `${r.platform}: ${r.found}`))
      .join(', ');

    res.json({
      success: true,
      scanned,
      results,
      message: results.length ? `Found ${scanned} jobs. ${summary}` : 'No searchable platforms are enabled.',
    });
  } catch (err: any) {
    logger.error({ err: err.message }, 'Failed running job scan');
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/jobs/:id - Single job details & match breakdown
jobsRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const repo = getRepository();
    const userId = getUserId(req);
    const job = await repo.getJob(req.params.id);
    if (!job) {
      return res.status(404).json({ success: false, error: 'Job not found' });
    }

    const profile = await repo.getProfile(userId);
    let match = await repo.getMatch(userId, job.id);

    if (!match) {
      const matchData = matchingEngine.calculateMatch(profile, job);
      match = await repo.saveMatch(matchData);
    }

    const [application, bookmarks] = await Promise.all([
      repo.getApplicationByJob(userId, job.id),
      repo.getBookmarks(userId),
    ]);

    res.json({
      success: true,
      data: {
        ...job,
        match,
        is_bookmarked: bookmarks.includes(job.id),
        application: application || null,
      },
    });
  } catch (err: any) {
    logger.error({ err: err.message }, 'Failed fetching job details');
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/jobs/:id/analyze - AI Job Description Analysis
jobsRouter.post('/:id/analyze', async (req: Request, res: Response) => {
  try {
    const repo = getRepository();
    const job = await repo.getJob(req.params.id);
    if (!job) {
      return res.status(404).json({ success: false, error: 'Job not found' });
    }

    const analysis = await aiService.analyzeJobDescription(job);
    const updated = await repo.upsertJob({
      ...job,
      extracted_metadata: analysis,
    });

    res.json({
      success: true,
      data: updated,
      analysis,
    });
  } catch (err: any) {
    logger.error({ err: err.message }, 'Failed analyzing job');
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/jobs/:id/match - Recalculate match
jobsRouter.post('/:id/match', async (req: Request, res: Response) => {
  try {
    const repo = getRepository();
    const userId = getUserId(req);
    const job = await repo.getJob(req.params.id);
    if (!job) {
      return res.status(404).json({ success: false, error: 'Job not found' });
    }

    const profile = await repo.getProfile(userId);
    const matchData = matchingEngine.calculateMatch(profile, job);
    const saved = await repo.saveMatch(matchData);

    res.json({
      success: true,
      data: saved,
    });
  } catch (err: any) {
    logger.error({ err: err.message }, 'Failed matching job');
    res.status(500).json({ success: false, error: err.message });
  }
});
