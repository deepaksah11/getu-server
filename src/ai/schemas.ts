import { z } from 'zod';

export const JobAnalysisSchema = z.object({
  job_title: z.string().nullish().transform(v => v || 'Untitled Position'),
  required_skills: z.array(z.string()).nullish().transform(v => v || []),
  preferred_skills: z.array(z.string()).nullish().transform(v => v || []),
  experience_required: z.string().nullish().transform(v => v || 'Not specified'),
  education_required: z.string().nullish().transform(v => v || 'Not specified'),
  responsibilities: z.array(z.string()).nullish().transform(v => v || []),
  technical_requirements: z.array(z.string()).nullish().transform(v => v || []),
  soft_skills: z.array(z.string()).nullish().transform(v => v || []),
  location: z.array(z.string()).nullish().transform(v => v || []),
  work_mode: z
    .enum(['Remote', 'Hybrid', 'Onsite', 'Flexible'])
    .or(z.string())
    .nullish()
    .transform(v => {
      if (v === 'Remote' || v === 'Hybrid' || v === 'Onsite') return v;
      return 'Flexible';
    }),
  salary_range: z.string().nullish().transform(v => v || 'Competitive'),
  eligibility_notes: z.string().nullish().transform(v => v || ''),
  keywords: z.array(z.string()).nullish().transform(v => v || []),
  detected_questions: z
    .array(
      z.object({
        question: z.string(),
        type: z.preprocess(v => (v ? String(v) : 'technical'), z.string()),
        is_required: z.preprocess(v => (v === false ? false : true), z.boolean()),
      })
    )
    .nullish()
    .transform(v => v || []),
});

export type JobAnalysisOutput = z.infer<typeof JobAnalysisSchema>;

export const ResumeTailoringSchema = z.object({
  tailored_summary: z.string(),
  highlighted_skills: z.array(
    z.object({
      category: z.string(),
      items: z.array(z.string()),
    })
  ),
  tailored_experience: z.array(
    z.object({
      company: z.string(),
      role: z.string(),
      period: z.string(),
      location: z.string().nullish().transform(v => v || undefined),
      bullets: z.array(z.string()),
      technologies: z.array(z.string()),
    })
  ),
  tailored_projects: z.array(
    z.object({
      title: z.string(),
      description: z.string(),
      bullets: z.array(z.string()),
      technologies: z.array(z.string()),
      link: z.string().nullish().transform(v => v || undefined),
    })
  ),
  keywords_incorporated: z.array(z.string()).nullish().transform(v => v || []),
  rationale: z.string().nullish().transform(v => v || ''),
});

export type ResumeTailoringOutput = z.infer<typeof ResumeTailoringSchema>;

export const QuestionAnswerSchema = z.object({
  answers: z.array(
    z.object({
      question: z.string(),
      answer: z.string(),
      is_factual: z.boolean().default(true),
      source_field: z.string().default('candidate_profile'),
      confidence_score: z.number().min(0).max(1).default(1.0),
    })
  ),
});

export type QuestionAnswerOutput = z.infer<typeof QuestionAnswerSchema>;

export const FormAnswerSchema = z.object({
  answer: z.preprocess((v) => (v === null || v === undefined ? '' : String(v)), z.string()),
  confidence: z.coerce.number().min(0).max(1).catch(0),
});

export const CoverLetterSchema = z.object({
  cover_letter: z.string().min(50),
});

export const ATSCheckSchema = z.object({
  overall_score: z.number().min(0).max(100),
  keyword_coverage_percent: z.number().min(0).max(100),
  formatting_score: z.number().min(0).max(100),
  readability_score: z.number().min(0).max(100),
  matched_keywords: z.array(z.string()),
  missing_keywords: z.array(z.string()),
  actionable_issues: z.array(z.string()),
});

export type ATSCheckOutput = z.infer<typeof ATSCheckSchema>;

export const ResumeExtractionSchema = z.object({
  full_name: z.string().nullish().transform((v) => v || ''),
  email: z.string().nullish().transform((v) => v || ''),
  phone: z.string().nullish().transform((v) => v || ''),
  location: z.string().nullish().transform((v) => v || ''),
  professional_summary: z.string().nullish().transform((v) => v || ''),
  years_of_experience: z
    .number()
    .or(z.string().regex(/\d+/).transform((v) => parseFloat(v) || 0))
    .nullish()
    .transform((v) => (typeof v === 'number' ? v : 0)),
  salary_expectation: z.string().nullish().transform((v) => v || ''),
  notice_period_days: z
    .number()
    .or(z.string().regex(/\d+/).transform((v) => parseInt(v, 10) || 0))
    .nullish()
    .transform((v) => (typeof v === 'number' ? v : 0)),
  skills: z.array(z.string()).nullish().transform((v) => v || []),
  skills_categorized: z
    .object({
      languages: z.array(z.string()).nullish().transform((v) => v || []),
      frameworks: z.array(z.string()).nullish().transform((v) => v || []),
      databases: z.array(z.string()).nullish().transform((v) => v || []),
      cloud_devops: z.array(z.string()).nullish().transform((v) => v || []),
      tools: z.array(z.string()).nullish().transform((v) => v || []),
    })
    .nullish()
    .transform(
      (v) =>
        v || { languages: [], frameworks: [], databases: [], cloud_devops: [], tools: [] }
    ),
  experience: z
    .array(
      z.object({
        company: z.string().nullish().transform((v) => v || ''),
        role: z.string().nullish().transform((v) => v || ''),
        period: z.string().nullish().transform((v) => v || ''),
        location: z.string().nullish().transform((v) => v || undefined),
        bullets: z.array(z.string()).nullish().transform((v) => v || []),
        technologies: z.array(z.string()).nullish().transform((v) => v || []),
      })
    )
    .nullish()
    .transform((v) => (v || []).filter((item) => item.company || item.role)),
  education: z
    .array(
      z.object({
        institution: z.string().nullish().transform((v) => v || ''),
        degree: z.string().nullish().transform((v) => v || ''),
        field_of_study: z.string().nullish().transform((v) => v || ''),
        graduation_year: z.string().nullish().transform((v) => v || ''),
        gpa: z.string().nullish().transform((v) => v || undefined),
      })
    )
    .nullish()
    .transform((v) => (v || []).filter((item) => item.institution || item.degree)),
  projects: z
    .array(
      z.object({
        title: z.string().nullish().transform((v) => v || ''),
        description: z.string().nullish().transform((v) => v || ''),
        bullets: z.array(z.string()).nullish().transform((v) => v || []),
        technologies: z.array(z.string()).nullish().transform((v) => v || []),
        link: z.string().nullish().transform((v) => v || undefined),
      })
    )
    .nullish()
    .transform((v) => (v || []).filter((item) => item.title || item.description)),
  certifications: z.array(z.string()).nullish().transform((v) => v || []),
  linkedin_url: z.string().nullish().transform((v) => v || undefined),
  github_url: z.string().nullish().transform((v) => v || undefined),
  portfolio_url: z.string().nullish().transform((v) => v || undefined),
});

export type ResumeExtractionOutput = z.infer<typeof ResumeExtractionSchema>;
