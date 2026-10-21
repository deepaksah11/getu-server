import path from 'path';
import {
  CandidateProfile,
  MasterResume,
  MasterResumeContent,
  NormalizedJob,
  ResumeVersion,
} from '../types/index.js';
import { aiService } from '../ai/aiService.js';
import { JobAnalysisOutput } from '../ai/schemas.js';
import { atsChecker } from './atsChecker.js';
import { pdfGenerator } from './pdfGenerator.js';
import { docxGenerator } from './docxGenerator.js';
import { getRepository } from '../db/client.js';
import { logger } from '../config/logger.js';
import { paths } from '../config/paths.js';

function safeFilePart(value: string, max = 40): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, max) || 'job';
}

export class TailoringEngine {
  public async generateTailoredResume(
    candidate: CandidateProfile,
    masterResume: MasterResume,
    job: NormalizedJob,
    templateId: 'ats_classic' | 'modern_pro' | 'backend_dev' = 'ats_classic',
    analysis?: JobAnalysisOutput
  ): Promise<ResumeVersion> {
    const repo = getRepository();

    const jdAnalysis = analysis || (await aiService.analyzeJobDescription(job));
    const tailored = await aiService.tailorResume(candidate, masterResume, job, jdAnalysis);

    const versionContent: MasterResumeContent = {
      summary: tailored.tailored_summary,
      skills: tailored.highlighted_skills,
      experience: tailored.tailored_experience,
      projects: tailored.tailored_projects,
      // Profile first (it holds manual edits); the master resume only fills empty sections
      education:
        candidate.education.length > 0
          ? candidate.education.map((e) => ({
              institution: e.institution,
              degree: [e.degree, e.field_of_study].filter(Boolean).join(' in '),
              year: e.end_year ? String(e.end_year) : e.start_year ? String(e.start_year) : '',
              details: e.grade ? `Grade: ${e.grade}` : undefined,
            }))
          : masterResume.content_json.education || [],
      certifications: candidate.certifications?.length ? candidate.certifications : masterResume.content_json.certifications || [],
      achievements: candidate.achievements?.length ? candidate.achievements : masterResume.content_json.achievements || [],
    };

    const atsResult = atsChecker.evaluate(versionContent, job);

    const baseName = `${safeFilePart(candidate.full_name, 30)}_${safeFilePart(job.company)}_${safeFilePart(job.title)}_${Date.now()}`;
    const pdfPath = path.join(paths.resumesDir, `${baseName}.pdf`);
    const docxPath = path.join(paths.resumesDir, `${baseName}.docx`);

    let pdfOk = false;
    let docxOk = false;
    try {
      await pdfGenerator.generateResumePDF(candidate, versionContent, templateId, pdfPath);
      pdfOk = true;
    } catch (err: any) {
      logger.error({ err: err.message }, 'Failed generating resume PDF');
    }
    try {
      await docxGenerator.generateResumeDOCX(candidate, versionContent, docxPath);
      docxOk = true;
    } catch (err: any) {
      logger.error({ err: err.message }, 'Failed generating resume DOCX');
    }
    if (!pdfOk && !docxOk) {
      throw new Error('Could not generate the tailored resume files');
    }

    let coverLetter: string | undefined;
    try {
      coverLetter = await aiService.generateCoverLetter(candidate, job);
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Cover letter generation failed; continuing without one');
    }

    return repo.createResumeVersion({
      user_id: candidate.user_id,
      master_resume_id: masterResume.id,
      job_id: job.id,
      title: `${job.title} — ${job.company}`,
      template_id: templateId,
      content_json: versionContent,
      ats_score: atsResult.score,
      missing_keywords: atsResult.missing_keywords,
      ats_feedback: {
        keyword_coverage: atsResult.keyword_coverage,
        formatting_score: atsResult.formatting_score,
        readability_score: atsResult.readability_score,
        issues: atsResult.issues,
      },
      cover_letter: coverLetter,
      pdf_path: pdfOk ? pdfPath : undefined,
      docx_path: docxOk ? docxPath : undefined,
    });
  }
}

export const tailoringEngine = new TailoringEngine();
