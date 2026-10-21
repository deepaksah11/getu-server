import { Router, Request, Response } from 'express';
import fs from 'fs';
import { getRepository } from '../db/client.js';
import { getUserId } from '../utils/auth.js';
import { tailoringEngine } from '../resumes/tailoringEngine.js';
import { logger } from '../config/logger.js';

export const resumesRouter = Router();

// GET /api/resumes/master - Retrieve Master Resume
resumesRouter.get('/master', async (req: Request, res: Response) => {
  try {
    const repo = getRepository();
    const userId = getUserId(req);
    const master = await repo.getMasterResume(userId);
    res.json({ success: true, data: master });
  } catch (err: any) {
    logger.error({ err: err.message }, 'Failed fetching master resume');
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/resumes/master - Update Master Resume Content
resumesRouter.put('/master', async (req: Request, res: Response) => {
  try {
    const repo = getRepository();
    const userId = getUserId(req);
    const updated = await repo.updateMasterResume(userId, req.body.content_json);
    res.json({ success: true, data: updated });
  } catch (err: any) {
    logger.error({ err: err.message }, 'Failed updating master resume');
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/resumes/versions - List tailored versions
resumesRouter.get('/versions', async (req: Request, res: Response) => {
  try {
    const repo = getRepository();
    const userId = getUserId(req);
    const jobId = req.query.job_id as string | undefined;
    const versions = await repo.getResumeVersions(userId, jobId);
    res.json({ success: true, data: versions });
  } catch (err: any) {
    logger.error({ err: err.message }, 'Failed fetching resume versions');
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/resumes/versions/:id - Single resume version
resumesRouter.get('/versions/:id', async (req: Request, res: Response) => {
  try {
    const repo = getRepository();
    const version = await repo.getResumeVersion(req.params.id);
    if (!version) {
      return res.status(404).json({ success: false, error: 'Resume version not found' });
    }
    res.json({ success: true, data: version });
  } catch (err: any) {
    logger.error({ err: err.message }, 'Failed fetching resume version');
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/resumes/generate - Tailor a new resume version for a job
resumesRouter.post('/generate', async (req: Request, res: Response) => {
  try {
    const repo = getRepository();
    const userId = getUserId(req);
    const { jobId, templateId } = req.body;

    if (!jobId) {
      return res.status(400).json({ success: false, error: 'jobId is required' });
    }

    const job = await repo.getJob(jobId);
    if (!job) {
      return res.status(404).json({ success: false, error: 'Job not found' });
    }

    const profile = await repo.getProfile(userId);
    const master = await repo.getMasterResume(userId);

    const version = await tailoringEngine.generateTailoredResume(
      profile,
      master,
      job,
      templateId || 'ats_classic'
    );

    res.json({ success: true, data: version });
  } catch (err: any) {
    logger.error({ err: err.message }, 'Failed generating tailored resume');
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/resumes/versions/:id - Delete a version
resumesRouter.delete('/versions/:id', async (req: Request, res: Response) => {
  try {
    const repo = getRepository();
    const deleted = await repo.deleteResumeVersion(req.params.id);
    res.json({ success: deleted });
  } catch (err: any) {
    logger.error({ err: err.message }, 'Failed deleting resume version');
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/resumes/download/:id/:format - Download PDF or DOCX file
resumesRouter.get('/download/:id/:format', async (req: Request, res: Response) => {
  try {
    const repo = getRepository();
    const version = await repo.getResumeVersion(req.params.id);
    if (!version) {
      return res.status(404).json({ success: false, error: 'Resume version not found' });
    }

    const format = req.params.format.toLowerCase();
    const filePath = format === 'docx' ? version.docx_path : version.pdf_path;

    if (!filePath || !fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, error: 'File not found on disk' });
    }

    const filename = `${version.title.replace(/[^a-zA-Z0-9_-]/g, '_')}.${format}`;
    res.download(filePath, filename);
  } catch (err: any) {
    logger.error({ err: err.message }, 'Failed downloading resume file');
    res.status(500).json({ success: false, error: err.message });
  }
});
