import { MasterResumeContent, NormalizedJob } from '../types/index.js';

export interface ATSCheckResult {
  score: number;
  keyword_coverage: number;
  formatting_score: number;
  readability_score: number;
  missing_keywords: string[];
  matched_keywords: string[];
  issues: string[];
}

export class ATSChecker {
  public evaluate(resume: MasterResumeContent, job: NormalizedJob): ATSCheckResult {
    const issues: string[] = [];
    let formattingScore = 100;
    let readabilityScore = 95;

    // 1. Check Required Sections
    if (!resume.summary || resume.summary.length < 50) {
      issues.push('Professional summary is too brief or missing.');
      formattingScore -= 15;
    }
    if (!resume.skills || resume.skills.length === 0) {
      issues.push('Technical skills section is missing or empty.');
      formattingScore -= 25;
    }
    if (!resume.experience || resume.experience.length === 0) {
      issues.push('Work experience section is missing or empty.');
      formattingScore -= 30;
    }
    if (!resume.education || resume.education.length === 0) {
      issues.push('Education section is missing.');
      formattingScore -= 10;
    }

    // 2. Keyword Coverage Check
    const resumeText = [
      resume.summary,
      ...resume.skills.flatMap((s) => s.items),
      ...resume.experience.flatMap((e) => [...e.bullets, ...(e.technologies || [])]),
      ...resume.projects.flatMap((p) => [...p.bullets, ...(p.technologies || [])]),
    ]
      .join(' ')
      .toLowerCase();

    // Extract core technical keywords from job
    const stopWords = new Set([
      'with', 'strong', 'experience', 'knowledge', 'solid', 'familiarity',
      'hands-on', 'years', 'using', 'understanding', 'good', 'deep', 'ability'
    ]);

    const targetKeywords = Array.from(
      new Set([
        ...job.skills,
        ...job.requirements.flatMap((r) =>
          r
            .split(/[\s,.;:()]+/)
            .filter((w) => w.length > 3 && !stopWords.has(w.toLowerCase()))
        ),
      ])
    ).filter((k) => k.length > 2);

    const matchedKeywords: string[] = [];
    const missingKeywords: string[] = [];

    for (const kw of targetKeywords) {
      const lower = kw.toLowerCase();
      if (resumeText.includes(lower)) {
        matchedKeywords.push(kw);
      } else {
        missingKeywords.push(kw);
      }
    }

    const keywordCoverage =
      targetKeywords.length > 0
        ? Math.min(100, Math.round((matchedKeywords.length / targetKeywords.length) * 100))
        : 90;

    // 3. Keyword Stuffing / Length Check
    const totalWords = resumeText.split(/\s+/).length;
    if (totalWords > 1200) {
      issues.push('Resume length exceeds recommended 2-page equivalent (risk of ATS truncation).');
      readabilityScore -= 15;
    } else if (totalWords < 200) {
      issues.push('Resume content is too sparse for complete ATS evaluation.');
      readabilityScore -= 20;
    }

    // 4. Calculate Final Composite ATS Score
    const weightedScore = Math.round(
      keywordCoverage * 0.5 + formattingScore * 0.3 + readabilityScore * 0.2
    );

    return {
      score: Math.max(10, Math.min(100, weightedScore)),
      keyword_coverage: keywordCoverage,
      formatting_score: Math.max(0, formattingScore),
      readability_score: Math.max(0, readabilityScore),
      matched_keywords: matchedKeywords,
      missing_keywords: missingKeywords,
      issues,
    };
  }
}

export const atsChecker = new ATSChecker();
