import { Router, Request, Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { masterContentFromProfile } from '../resumes/masterFromProfile.js';
import { getRepository } from '../db/client.js';
import { getUserId } from '../utils/auth.js';
import { aiService } from '../ai/aiService.js';
import { matchingEngine } from '../matching/matchingEngine.js';
import { logger } from '../config/logger.js';
import {
  CandidateProfile,
  CandidateSkill,
  CandidateExperience,
  CandidateEducation,
  CandidateProject,
  MasterResumeContent,
} from '../types/index.js';
import { ResumeExtractionOutput } from '../ai/schemas.js';
import { profileReadiness } from '../automation/readiness.js';

export const profileRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
});

/**
 * Helper to extract plain text from an uploaded file buffer (PDF, DOCX, TXT)
 */
async function extractTextFromFile(buffer: Buffer, mimetype?: string, originalname?: string): Promise<string> {
  const lowerName = (originalname || '').toLowerCase();
  const isPdf = mimetype === 'application/pdf' || lowerName.endsWith('.pdf');
  const isDocx =
    mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    lowerName.endsWith('.docx');

  if (isPdf) {
    try {
      const pdfModule: any = await import('pdf-parse');
      const PDFParse = pdfModule.PDFParse || pdfModule.default?.PDFParse || pdfModule.default || pdfModule;
      if (typeof PDFParse === 'function') {
        const parser = new PDFParse({ data: buffer });
        const res = await parser.getText();
        const text = typeof res === 'string' ? res : res?.text || '';
        if (text && text.trim().length > 20) return text;
      }
    } catch (err: any) {
      logger.warn({ err: err.message }, 'PDFParse extraction failed, falling back to ASCII stream');
    }

    // PDF Fallback: extract printable strings
    const raw = buffer.toString('latin1');
    const clean = raw.replace(/[^\x20-\x7E\n\r\t]/g, ' ');
    return clean;
  }

  if (isDocx) {
    try {
      const zlib = await import('node:zlib');
      let offset = 0;
      while (offset < buffer.length - 30) {
        if (buffer.readUInt32LE(offset) === 0x04034b50) { // PK\x03\x04
          const compMethod = buffer.readUInt16LE(offset + 8);
          const compSize = buffer.readUInt32LE(offset + 18);
          const nameLen = buffer.readUInt16LE(offset + 26);
          const extraLen = buffer.readUInt16LE(offset + 28);
          const filename = buffer.toString('utf8', offset + 30, offset + 30 + nameLen);
          const dataStart = offset + 30 + nameLen + extraLen;

          if (filename === 'word/document.xml') {
            const compData = buffer.subarray(dataStart, dataStart + compSize);
            let xmlStr = '';
            if (compMethod === 8) {
              xmlStr = zlib.inflateRawSync(compData).toString('utf-8');
            } else if (compMethod === 0) {
              xmlStr = compData.toString('utf-8');
            }
            const docxText = xmlStr
              .replace(/<\/w:p>/gi, '\n')
              .replace(/<[^>]+>/g, ' ')
              .replace(/&amp;/g, '&')
              .replace(/&lt;/g, '<')
              .replace(/&gt;/g, '>')
              .replace(/&quot;/g, '"')
              .replace(/&apos;/g, "'")
              .replace(/[ \t]+/g, ' ')
              .trim();
            if (docxText.length > 20) return docxText;
          }
          offset = dataStart + compSize;
        } else {
          offset++;
        }
      }
    } catch (err: any) {
      logger.warn({ err: err.message }, 'DOCX extraction failed');
    }
  }

  // Text, markdown, or generic file
  return buffer.toString('utf-8');
}

/**
 * Helper to map extracted resume data to CandidateProfile model
 * STRICT RULE: Never injects dummy data (no placeholder names, companies, or schools)
 */
/** Profiles still holding sample data must not leak it into the user's real profile. */
function isSampleProfile(profile: CandidateProfile): boolean {
  return /@example\.(com|org)$/i.test(profile.email || '');
}

/** Years covered by a period string such as "Jan 2021 - Present" or "2019 – 2022". */
function periodYears(period: string): number {
  const years = Array.from(period.matchAll(/\b(19|20)\d{2}\b/g)).map((m) => parseInt(m[0], 10));
  if (years.length === 0) return 0;
  const months: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  const monthHits = Array.from(period.toLowerCase().matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/g)).map((m) => months[m[1]]);
  const start = years[0] + (monthHits[0] ?? 0) / 12;
  const current = /present|current|now|till date|ongoing/i.test(period);
  const now = new Date();
  const end = current ? now.getFullYear() + now.getMonth() / 12 : (years[1] ?? years[0]) + (monthHits[1] ?? 11) / 12;
  return Math.max(0, end - start);
}

/**
 * Skill experience is estimated only from roles that mention the skill, so the
 * bot never claims more years with a technology than the resume shows.
 */
function skillYears(skill: string, extracted: ResumeExtractionOutput): number {
  const lower = skill.toLowerCase();
  const total = extracted.experience
    .filter((e) => e.technologies.some((t) => t.toLowerCase() === lower) || e.bullets.some((b) => b.toLowerCase().includes(lower)))
    .reduce((sum, e) => sum + periodYears(e.period), 0);
  if (total > 0) return Math.round(Math.min(total, extracted.years_of_experience || total) * 10) / 10;
  const inProjects = extracted.projects.some(
    (p) => p.technologies.some((t) => t.toLowerCase() === lower) || `${p.description} ${p.bullets.join(' ')}`.toLowerCase().includes(lower)
  );
  return inProjects || extracted.years_of_experience >= 1 ? 1 : 0;
}

function mapExtractedToProfile(
  userId: string,
  extracted: ResumeExtractionOutput,
  existingProfile?: CandidateProfile
): Partial<CandidateProfile> {
  // Sample data must never fill gaps in the real profile
  const existing = existingProfile && !isSampleProfile(existingProfile) ? existingProfile : undefined;
  const skills: CandidateSkill[] = extracted.skills.map((s, idx) => {
    const years = skillYears(s, extracted);
    return {
      id: `skill-${idx + 1}`,
      name: s,
      category: 'Technical',
      proficiency: years >= 5 ? 'Expert' : years >= 3 ? 'Advanced' : years >= 1 ? 'Intermediate' : 'Beginner',
      years_experience: years,
    };
  });

  const experience: CandidateExperience[] = extracted.experience.map((exp, idx) => {
    const isCurrent = /present|current|now|till date/i.test(exp.period);
    const parts = exp.period.split(/\s*(?:–|—|-|\bto\b)\s*/i).map((p) => p.trim());
    return {
      id: `exp-${idx + 1}`,
      company: exp.company,
      role: exp.role,
      location: exp.location,
      start_date: parts[0] || '',
      end_date: isCurrent ? undefined : parts[1] || '',
      is_current: isCurrent,
      bullets: exp.bullets,
      technologies: exp.technologies,
    };
  });

  const education: CandidateEducation[] = extracted.education.map((edu, idx) => {
    const yr = parseInt(edu.graduation_year.replace(/\D/g, ''), 10) || new Date().getFullYear();
    return {
      id: `edu-${idx + 1}`,
      institution: edu.institution,
      degree: edu.degree,
      field_of_study: edu.field_of_study,
      start_year: yr - 4,
      end_year: yr,
      grade: edu.gpa,
    };
  });

  const projects: CandidateProject[] = extracted.projects.map((proj, idx) => ({
    id: `proj-${idx + 1}`,
    title: proj.title,
    description: proj.description,
    role: '',
    url: proj.link,
    technologies: proj.technologies,
    bullets: proj.bullets,
  }));

  return {
    user_id: userId,
    full_name: extracted.full_name || existing?.full_name || '',
    email: extracted.email || existing?.email || '',
    phone: extracted.phone || existing?.phone || '',
    location: extracted.location || existing?.location || '',
    professional_summary:
      extracted.professional_summary || existing?.professional_summary || '',
    years_of_experience: extracted.years_of_experience || existing?.years_of_experience || 0,
    notice_period_days: extracted.notice_period_days || existing?.notice_period_days || 30,
    salary_expectation:
      extracted.salary_expectation || existing?.salary_expectation || '',
    work_mode_preference: existing?.work_mode_preference || 'Remote or Hybrid',
    // The user's own target roles/locations win over guesses from the resume
    preferred_roles:
      existing?.preferred_roles?.length
        ? existing.preferred_roles
        : extracted.experience[0]?.role
          ? [extracted.experience[0].role]
          : [],
    preferred_locations:
      existing?.preferred_locations?.length
        ? existing.preferred_locations
        : extracted.location
          ? [extracted.location.split(',')[0].trim()]
          : [],
    linkedin_url: extracted.linkedin_url || existing?.linkedin_url,
    github_url: extracted.github_url || existing?.github_url,
    portfolio_url: extracted.portfolio_url || existing?.portfolio_url,
    languages: existing?.languages || ['English'],
    certifications: extracted.certifications.length > 0 ? extracted.certifications : existing?.certifications || [],
    achievements: existing?.achievements || [],
    skills: skills.length > 0 ? skills : existing?.skills || [],
    experience: experience.length > 0 ? experience : existing?.experience || [],
    education: education.length > 0 ? education : existing?.education || [],
    projects: projects.length > 0 ? projects : existing?.projects || [],
  };
}

// GET /api/profile - Get profile
profileRouter.get('/', async (req: Request, res: Response) => {
  try {
    const repo = getRepository();
    const userId = getUserId(req);
    const profile = await repo.getProfile(userId);
    res.json({ success: true, data: profile });
  } catch (err: any) {
    logger.error({ err: err.message }, 'Failed fetching candidate profile');
    res.status(500).json({ success: false, error: err.message });
  }
});

const text = (max: number) => z.string().trim().max(max);
const textList = (maxItems: number, maxLength: number) =>
  z
    .array(z.string())
    .max(maxItems)
    .transform((list) => list.map((s) => s.trim().slice(0, maxLength)).filter(Boolean));
const year = z
  .union([z.number(), z.string()])
  .nullish()
  .transform((v) => {
    const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
    return Number.isFinite(n) && n >= 1950 && n <= 2100 ? n : undefined;
  });

/** Manual profile edits from the Profile page. Unknown keys are dropped, empty entries removed. */
const ProfileUpdateSchema = z
  .object({
    full_name: text(120),
    email: text(200).refine((v) => v === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), 'Enter a valid email address'),
    phone: text(40),
    location: text(200),
    professional_summary: text(5000),
    years_of_experience: z.coerce.number().min(0).max(60),
    notice_period_days: z.coerce.number().int().min(0).max(365),
    salary_expectation: text(100),
    current_ctc: text(100),
    work_mode_preference: text(100),
    preferred_roles: textList(30, 120),
    preferred_locations: textList(30, 120),
    languages: textList(30, 80),
    certifications: textList(50, 300),
    achievements: textList(50, 500),
    linkedin_url: text(300),
    github_url: text(300),
    portfolio_url: text(300),
    work_authorized: z.boolean(),
    requires_sponsorship: z.boolean(),
    willing_to_relocate: z.boolean(),
    gender: z
      .string()
      .max(50)
      .nullish()
      .transform((v) => (v ? v.trim() : undefined)),
    skills: z
      .array(
        z.object({
          id: z.string().optional(),
          name: text(80),
          category: z.enum(['Technical', 'Soft', 'Tool', 'Framework']).catch('Technical'),
          proficiency: z.enum(['Beginner', 'Intermediate', 'Advanced', 'Expert']).catch('Intermediate'),
          years_experience: z.coerce.number().min(0).max(60).catch(0),
        })
      )
      .max(200)
      .transform((list) => {
        const seen = new Set<string>();
        return list.filter((s) => s.name && !seen.has(s.name.toLowerCase()) && seen.add(s.name.toLowerCase()));
      }),
    experience: z
      .array(
        z.object({
          id: z.string().optional(),
          company: text(150).default(''),
          role: text(150).default(''),
          location: text(150).optional(),
          start_date: text(40).default(''),
          end_date: text(40).optional(),
          is_current: z.boolean().default(false),
          description: text(2000).optional(),
          bullets: textList(30, 1000).default([]),
          technologies: textList(50, 80).default([]),
        })
      )
      .max(30)
      .transform((list) =>
        list
          .filter((e) => e.company || e.role)
          .map((e) => ({ ...e, end_date: e.is_current ? undefined : e.end_date || undefined }))
      ),
    projects: z
      .array(
        z.object({
          id: z.string().optional(),
          title: text(150).default(''),
          description: text(2000).default(''),
          role: text(150).optional(),
          url: text(300).optional(),
          technologies: textList(50, 80).default([]),
          bullets: textList(30, 1000).default([]),
        })
      )
      .max(30)
      .transform((list) => list.filter((p) => p.title)),
    education: z
      .array(
        z.object({
          id: z.string().optional(),
          institution: text(200).default(''),
          degree: text(150).default(''),
          field_of_study: text(150).default(''),
          start_year: year,
          end_year: year,
          grade: text(50).optional(),
        })
      )
      .max(20)
      .transform((list) =>
        list
          .filter((e) => e.institution || e.degree)
          .map((e) => ({ ...e, start_year: e.start_year ?? e.end_year ?? 0, end_year: e.end_year }))
      ),
  })
  .partial();

/** Re-scores known jobs against the updated profile without holding up the save. */
async function recomputeMatches(userId: string, profile: CandidateProfile): Promise<void> {
  const repo = getRepository();
  const prefs = await repo.getPreferences(userId);
  const { jobs } = await repo.getJobs({ limit: 1000 });
  for (const job of jobs) {
    await repo.saveMatch(matchingEngine.calculateMatch(profile, job, prefs.preferred_roles || []));
  }
}

// PUT /api/profile - Save manual profile edits (profile is the source of truth for resumes and forms)
profileRouter.put('/', async (req: Request, res: Response) => {
  const parsed = ProfileUpdateSchema.safeParse(req.body || {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue.path.filter((p) => typeof p === 'string').join(' ');
    return res.status(400).json({ success: false, error: `${field ? `${field}: ` : ''}${issue.message}` });
  }
  try {
    const repo = getRepository();
    const userId = getUserId(req);
    const updated = await repo.updateProfile(userId, parsed.data as Partial<CandidateProfile>);

    // Keep the master resume in step with what the user entered, so tailored resumes use it
    const master = await repo.getMasterResume(userId);
    await repo.updateMasterResume(userId, masterContentFromProfile(updated, master.content_json));

    res.json({ success: true, data: updated });

    recomputeMatches(userId, updated).catch((err) =>
      logger.warn({ err: err.message }, 'Recomputing job matches after profile update failed')
    );
  } catch (err: any) {
    logger.error({ err: err.message }, 'Failed updating candidate profile');
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/profile/extract-resume - Parse resume file or text and extract candidate profile
profileRouter.post('/extract-resume', upload.single('resume'), async (req: Request, res: Response) => {
  try {
    const repo = getRepository();
    let text = '';

    if (req.file) {
      logger.info(
        { filename: req.file.originalname, mimetype: req.file.mimetype, size: req.file.size },
        'Extracting text from uploaded resume file'
      );
      text = await extractTextFromFile(req.file.buffer, req.file.mimetype, req.file.originalname);
    } else if (req.body.text) {
      text = String(req.body.text);
    } else {
      return res.status(400).json({
        success: false,
        error: 'Please upload a resume file (PDF, DOCX, TXT) or provide raw resume text.',
      });
    }

    if (!text || text.trim().length < 20) {
      return res.status(400).json({
        success: false,
        error: 'Unable to extract text from the provided document. Please check the file format or paste text directly.',
      });
    }

    logger.info({ charCount: text.length }, 'Analyzing resume text with AI extraction engine');
    const extracted = await aiService.extractProfileFromResume(text);

    // Check if auto-apply was requested
    const autoSave = req.body.autoSave === 'true' || req.body.autoSave === true;

    if (autoSave) {
      const userId = getUserId(req);
      const existing = await repo.getProfile(userId);
      const profileUpdates = mapExtractedToProfile(userId, extracted, existing);
      const savedProfile = await repo.updateProfile(userId, profileUpdates);

      // Also update master resume
      const masterContent: MasterResumeContent = {
        summary: extracted.professional_summary,
        skills: [
          { category: 'Languages', items: extracted.skills_categorized.languages },
          { category: 'Frameworks & Libraries', items: extracted.skills_categorized.frameworks },
          { category: 'Databases & Storage', items: extracted.skills_categorized.databases },
          { category: 'Cloud & Infrastructure', items: extracted.skills_categorized.cloud_devops },
          { category: 'Developer Tools', items: extracted.skills_categorized.tools },
        ].filter((c) => c.items.length > 0),
        experience: extracted.experience.map((exp) => ({
          company: exp.company,
          role: exp.role,
          period: exp.period,
          location: exp.location,
          bullets: exp.bullets,
          technologies: exp.technologies,
        })),
        education: extracted.education.map((edu) => ({
          institution: edu.institution,
          degree: `${edu.degree} in ${edu.field_of_study}`,
          year: edu.graduation_year,
          details: edu.gpa ? `GPA: ${edu.gpa}` : undefined,
        })),
        projects: extracted.projects.map((proj) => ({
          title: proj.title,
          description: proj.description,
          bullets: proj.bullets,
          technologies: proj.technologies,
          link: proj.link,
        })),
        certifications: extracted.certifications,
        achievements: [],
      };
      await repo.updateMasterResume(userId, masterContent);

      // Recalculate matches for all jobs against the new ground truth
      const { jobs } = await repo.getJobs();
      for (const job of jobs) {
        const match = matchingEngine.calculateMatch(savedProfile, job);
        await repo.saveMatch(match);
      }

      return res.json({
        success: true,
        data: extracted,
        profile: savedProfile,
        applied: true,
        message: 'Resume extracted and saved to Candidate Profile & Master Resume successfully!',
      });
    }

    res.json({
      success: true,
      data: extracted,
      applied: false,
      message: 'Resume parsed successfully. Review extracted fields before applying.',
    });
  } catch (err: any) {
    logger.error({ err: err.message }, 'Failed parsing and extracting resume');
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/profile/apply-extracted - Apply extracted resume data to profile and master resume
profileRouter.post('/apply-extracted', async (req: Request, res: Response) => {
  try {
    const repo = getRepository();
    const extracted: ResumeExtractionOutput = req.body;
    if (!extracted || !extracted.full_name) {
      return res.status(400).json({ success: false, error: 'Valid extracted resume data is required' });
    }

    const userId = getUserId(req);
    const existing = await repo.getProfile(userId);
    const profileUpdates = mapExtractedToProfile(userId, extracted, existing);
    const savedProfile = await repo.updateProfile(userId, profileUpdates);

    // Update Master Resume
    const masterContent: MasterResumeContent = {
      summary: extracted.professional_summary,
      skills: [
        { category: 'Languages', items: extracted.skills_categorized?.languages || [] },
        { category: 'Frameworks & Libraries', items: extracted.skills_categorized?.frameworks || [] },
        { category: 'Databases & Storage', items: extracted.skills_categorized?.databases || [] },
        { category: 'Cloud & Infrastructure', items: extracted.skills_categorized?.cloud_devops || [] },
        { category: 'Developer Tools', items: extracted.skills_categorized?.tools || [] },
      ].filter((c) => c.items.length > 0),
      experience: (extracted.experience || []).map((exp) => ({
        company: exp.company,
        role: exp.role,
        period: exp.period,
        location: exp.location,
        bullets: exp.bullets,
        technologies: exp.technologies,
      })),
      education: (extracted.education || []).map((edu) => ({
        institution: edu.institution,
        degree: `${edu.degree} in ${edu.field_of_study}`,
        year: edu.graduation_year,
        details: edu.gpa ? `GPA: ${edu.gpa}` : undefined,
      })),
      projects: (extracted.projects || []).map((proj) => ({
        title: proj.title,
        description: proj.description,
        bullets: proj.bullets,
        technologies: proj.technologies,
        link: proj.link,
      })),
      certifications: extracted.certifications || [],
      achievements: [],
    };
    await repo.updateMasterResume(userId, masterContent);

    // Recalculate matches for all jobs
    const { jobs } = await repo.getJobs();
    for (const job of jobs) {
      const match = matchingEngine.calculateMatch(savedProfile, job);
      await repo.saveMatch(match);
    }

    logger.info({ userId, name: savedProfile.full_name }, 'Extracted profile applied to database');
    res.json({
      success: true,
      data: savedProfile,
      message: 'Candidate Profile and Master Resume updated with extracted data!',
    });
  } catch (err: any) {
    logger.error({ err: err.message }, 'Failed applying extracted resume to profile');
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/profile/readiness - is the profile complete enough to apply in the user's name?
profileRouter.get('/readiness', async (req: Request, res: Response) => {
  try {
    const profile = await getRepository().getProfile(getUserId(req));
    res.json({ success: true, data: profileReadiness(profile) });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});
