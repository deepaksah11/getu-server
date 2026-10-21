import crypto from 'crypto';
import { z } from 'zod';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { AIProvider } from './provider.js';
import { GeminiProvider } from './geminiProvider.js';
import {
  JobAnalysisSchema,
  JobAnalysisOutput,
  ResumeTailoringSchema,
  ResumeTailoringOutput,
  QuestionAnswerSchema,
  QuestionAnswerOutput,
  ResumeExtractionSchema,
  ResumeExtractionOutput,
  FormAnswerSchema,
  CoverLetterSchema,
} from './schemas.js';
import { CandidateProfile, MasterResume, NormalizedJob } from '../types/index.js';
import { getRepository } from '../db/client.js';
import { extractStructuredResumeFromText } from './resumeParserHelper.js';
import {
  analyzeJobDeterministic,
  answerQuestionsDeterministic,
  formatPeriod,
  tailorResumeDeterministic,
} from './deterministicEngine.js';
import { composeCoverLetter, pickOption, QuestionContext } from './answerRules.js';
import { skillsEquivalent } from './skillDictionary.js';

export class AIService {
  private provider: AIProvider | null;

  /**
   * Without a provider every task uses the deterministic engine, which only
   * reorganises facts from the profile and the job posting.
   */
  constructor(provider?: AIProvider | null) {
    if (provider !== undefined) {
      this.provider = provider;
    } else if (env.GEMINI_API_KEY) {
      this.provider = new GeminiProvider(env.GEMINI_API_KEY, env.GEMINI_MODEL);
    } else {
      logger.warn('No GEMINI_API_KEY configured: AI tasks use the offline deterministic engine.');
      this.provider = null;
    }
  }

  public setProvider(provider: AIProvider | null) {
    this.provider = provider;
  }

  public getProvider(): AIProvider | null {
    return this.provider;
  }

  public hasProvider(): boolean {
    return this.provider !== null;
  }

  private computeHash(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  /**
   * Executes AI generation with caching, cost tracking, Zod validation and repair
   * retries. When the provider is missing or keeps failing, `fallback` (if given)
   * produces the result instead; otherwise the task throws.
   */
  public async executeStructuredTask<T>(
    taskName: string,
    prompt: string,
    schema: z.ZodType<T, any, any>,
    systemInstruction: string,
    cacheKeyPrefix?: string,
    fallback?: () => T
  ): Promise<T> {
    if (!this.provider) {
      if (fallback) return fallback();
      throw new Error(`No AI provider configured for task '${taskName}'`);
    }

    const repo = getRepository();
    const promptHash = this.computeHash(prompt);
    const cacheKey = cacheKeyPrefix ? `${cacheKeyPrefix}:${promptHash}` : undefined;

    if (cacheKey) {
      try {
        const cached = await repo.getCachedAI(cacheKey);
        if (cached) {
          const parsed = schema.safeParse(cached);
          if (parsed.success) {
            logger.debug({ taskName, cacheKey }, 'AI response served from cache');
            return parsed.data;
          }
        }
      } catch (err) {
        logger.warn({ err }, 'Cache read failed, proceeding with generation');
      }
    }

    const maxAttempts = 3;
    let currentPrompt = prompt;
    let lastError: any = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const startTime = Date.now();
      let result;
      try {
        result = await this.provider.generateText(currentPrompt, {
          temperature: 0.1,
          systemInstruction,
          responseMimeType: 'application/json',
        });
      } catch (err: any) {
        // Transport / quota errors will not be fixed by re-prompting; one retry is enough
        lastError = err;
        logger.warn({ taskName, attempt, err: err.message?.slice(0, 200) }, 'AI provider call failed');
        if (attempt >= 2) break;
        continue;
      }

      let parsedJson: any;
      try {
        let cleaned = result.text.trim();
        cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
        parsedJson = JSON.parse(cleaned);
      } catch (jsonErr: any) {
        logger.warn({ taskName, attempt, err: jsonErr.message }, 'Failed parsing AI JSON response');
        currentPrompt = `${prompt}\n\nIMPORTANT: Your previous output was not valid JSON. Fix the syntax and return ONLY valid JSON matching the exact schema:\nError: ${jsonErr.message}`;
        lastError = jsonErr;
        continue;
      }

      const validation = schema.safeParse(parsedJson);
      if (!validation.success) {
        const formatted = validation.error.format();
        logger.warn({ taskName, attempt }, 'AI output failed Zod schema validation');
        currentPrompt = `${prompt}\n\nCRITICAL FIX REQUIRED: Your previous response failed schema validation:\n${JSON.stringify(
          formatted
        ).slice(0, 2000)}\nReturn valid JSON strictly matching the requested schema with all required fields.`;
        lastError = validation.error;
        continue;
      }

      const costUsd = (result.inputTokens / 1_000_000) * 0.3 + (result.outputTokens / 1_000_000) * 2.5;
      await repo.logAIRequest(
        {
          cache_key: cacheKey,
          provider: this.provider.name,
          model: result.model,
          task: taskName,
          prompt_hash: promptHash,
          input_tokens: result.inputTokens,
          output_tokens: result.outputTokens,
          cost_usd: costUsd,
          latency_ms: Date.now() - startTime,
          status: 'success',
        },
        validation.data
      );

      return validation.data;
    }

    if (fallback) {
      logger.warn(
        { taskName, error: lastError?.message?.slice(0, 200) },
        'AI provider unavailable; using the deterministic engine for this task'
      );
      return fallback();
    }

    throw new Error(
      `AI structured generation for task '${taskName}' failed after ${maxAttempts} attempts: ${lastError?.message}`
    );
  }

  /** AI job description analysis */
  async analyzeJobDescription(job: NormalizedJob): Promise<JobAnalysisOutput> {
    const prompt = `
JD_ANALYSIS: Analyze this job description and extract requirements:

Job Title: ${job.title}
Company: ${job.company}
Work Mode: ${job.work_mode}
Locations: ${job.locations.join(', ')}
Original Description:
${job.description.slice(0, 12000)}

Requirements List from posting:
${job.requirements.join('\n')}

Extract:
1. job_title
2. required_skills (array of core technical skills)
3. preferred_skills (array of nice-to-have skills)
4. experience_required (e.g. '5+ years')
5. education_required
6. responsibilities (key job functions)
7. technical_requirements (tools, frameworks, languages)
8. soft_skills
9. location (matching locations)
10. work_mode ('Remote', 'Hybrid', 'Onsite', or 'Flexible')
11. salary_range
12. eligibility_notes
13. keywords (high priority keywords for ATS)
14. detected_questions (only questions the posting explicitly asks applicants; empty array if none)

Return ONLY a JSON object with exactly these keys: job_title (string), required_skills, preferred_skills,
responsibilities, technical_requirements, soft_skills, location, keywords (arrays of strings),
experience_required, education_required, work_mode, salary_range, eligibility_notes (strings), and
detected_questions (array of { "question": string, "type": string, "is_required": boolean }).
`;

    const systemInstruction = `You are a staff-level technical recruiter and job analyst. Extract structured, precise, verified requirements from the job description. Output ONLY valid JSON matching the schema.`;

    return this.executeStructuredTask<JobAnalysisOutput>(
      'jd_analysis',
      prompt,
      JobAnalysisSchema,
      systemInstruction,
      `jd:${job.platform}:${job.external_id}`,
      () => analyzeJobDeterministic(job)
    );
  }

  /**
   * AI resume tailoring. The AI may reorder and rephrase, but every company,
   * project and skill in the output must exist in the candidate's profile.
   */
  async tailorResume(
    candidate: CandidateProfile,
    masterResume: MasterResume,
    job: NormalizedJob,
    analysis: JobAnalysisOutput
  ): Promise<ResumeTailoringOutput> {
    const deterministic = () => tailorResumeDeterministic(candidate, masterResume, job, analysis);
    const groundExperience =
      candidate.experience.length > 0
        ? candidate.experience.map((e) => ({
            company: e.company,
            role: e.role,
            period: formatPeriod(e),
            location: e.location,
            bullets: e.bullets,
            technologies: e.technologies,
          }))
        : masterResume.content_json.experience;
    const groundProjects =
      candidate.projects.length > 0
        ? candidate.projects.map((p) => ({ title: p.title, description: p.description, bullets: p.bullets, technologies: p.technologies, link: p.url }))
        : masterResume.content_json.projects;
    // The profile is the source of truth; the master resume only fills in when the profile has no skills
    const groundSkills = new Set(
      candidate.skills.length > 0
        ? candidate.skills.map((s) => s.name)
        : masterResume.content_json.skills.flatMap((g) => g.items)
    );

    if (!this.provider) return deterministic();

    const prompt = `
RESUME_TAILORING: Tailor this candidate's resume for the target job:

TARGET JOB:
Title: ${job.title} at ${job.company}
Required Skills: ${analysis.required_skills.join(', ')}
Preferred Skills: ${analysis.preferred_skills.join(', ')}
Key Responsibilities: ${analysis.responsibilities.slice(0, 5).join('; ')}

CANDIDATE GROUND TRUTH PROFILE (DO NOT INVENT ANYTHING OUTSIDE THIS):
Summary: ${candidate.professional_summary || masterResume.content_json.summary}
Years of Experience: ${candidate.years_of_experience}
Skills: ${Array.from(groundSkills).join(', ')}
Work Experience:
${groundExperience
  .map((e) => `- ${e.role} at ${e.company} (${e.period}): ${e.bullets.join(' | ')} (Tech: ${e.technologies.join(', ')})`)
  .join('\n')}
Projects:
${groundProjects.map((p) => `- ${p.title}: ${p.description} ${p.bullets.join(' | ')} (Tech: ${p.technologies.join(', ')})`).join('\n')}

STRICT RULES (VIOLATIONS WILL BE REJECTED):
1. Do NOT invent experience, companies, projects, metrics, or technologies.
2. If the JD requires a skill the candidate does not list, do NOT add it.
3. You MAY reorder skills, select the most relevant bullets, and rephrase the candidate's actual achievements to use the job's terminology.
4. Keep every company name, role title, date range, and number identical to the profile.
5. Include every work experience entry from the profile.

Return ONLY this JSON object:
{
  "tailored_summary": string (2-4 sentences),
  "highlighted_skills": [{ "category": string, "items": [string] }],
  "tailored_experience": [{ "company": string, "role": string, "period": string, "location": string, "bullets": [string], "technologies": [string] }],
  "tailored_projects": [{ "title": string, "description": string, "bullets": [string], "technologies": [string], "link": string }],
  "keywords_incorporated": [string],
  "rationale": string
}
`;

    const systemInstruction = `You are an expert resume writer. Tailor the candidate's verified resume to the job requirements. NEVER fabricate skills, employers, projects or metrics. Return strict JSON.`;

    const output = await this.executeStructuredTask<ResumeTailoringOutput>(
      'resume_tailoring',
      prompt,
      ResumeTailoringSchema,
      systemInstruction,
      `tailor:${candidate.id}:${job.id}:${candidate.updated_at}`,
      deterministic
    );

    return this.enforceGrounding(output, groundSkills, groundExperience, groundProjects, deterministic);
  }

  /** Removes anything from an AI tailoring result that is not backed by the profile. */
  private enforceGrounding(
    output: ResumeTailoringOutput,
    groundSkills: Set<string>,
    groundExperience: { company: string; role: string; period: string; location?: string; bullets: string[]; technologies: string[] }[],
    groundProjects: { title: string; description: string; bullets: string[]; technologies: string[]; link?: string }[],
    deterministic: () => ResumeTailoringOutput
  ): ResumeTailoringOutput {
    const skillList = Array.from(groundSkills);
    const isGroundedSkill = (item: string) => skillList.some((s) => skillsEquivalent(s, item));

    const sanitizedSkills = output.highlighted_skills
      .map((cat) => ({
        category: cat.category,
        items: cat.items.filter((item) => {
          const ok = isGroundedSkill(item);
          if (!ok) logger.warn({ rejectedSkill: item }, 'Hallucination guardrail removed unverified skill');
          return ok;
        }),
      }))
      .filter((cat) => cat.items.length > 0);

    const sameCompany = (a: string, b: string) => {
      const x = a.toLowerCase().trim();
      const y = b.toLowerCase().trim();
      return x === y || (x.length > 2 && y.length > 2 && (x.includes(y) || y.includes(x)));
    };

    // Each AI experience entry must map to a real one; facts (company, role, dates) come from the profile
    const experience = groundExperience.map((real) => {
      const ai = output.tailored_experience.find((e) => sameCompany(e.company, real.company));
      if (!ai) return real;
      const technologies = ai.technologies.filter(isGroundedSkill);
      return {
        company: real.company,
        role: real.role,
        period: real.period,
        location: real.location,
        bullets: ai.bullets.length > 0 ? ai.bullets : real.bullets,
        technologies: technologies.length > 0 ? technologies : real.technologies,
      };
    });
    const invented = output.tailored_experience.filter((e) => !groundExperience.some((r) => sameCompany(e.company, r.company)));
    if (invented.length) {
      logger.warn({ companies: invented.map((e) => e.company) }, 'Hallucination guardrail removed unverified employers');
    }

    let projects: ResumeTailoringOutput['tailored_projects'] = output.tailored_projects
      .map((ai) => {
        const real = groundProjects.find((p) => sameCompany(p.title, ai.title));
        if (!real) return null;
        return {
          title: real.title,
          description: ai.description || real.description,
          bullets: ai.bullets.length ? ai.bullets : real.bullets,
          technologies: ai.technologies.filter(isGroundedSkill).length ? ai.technologies.filter(isGroundedSkill) : real.technologies,
          link: real.link,
        };
      })
      .filter((p): p is NonNullable<typeof p> => p !== null);
    if (projects.length === 0 && groundProjects.length > 0) {
      projects = deterministic().tailored_projects;
    }

    return {
      ...output,
      highlighted_skills: sanitizedSkills.length > 0 ? sanitizedSkills : deterministic().highlighted_skills,
      tailored_experience: experience,
      tailored_projects: projects,
      keywords_incorporated: output.keywords_incorporated.filter(isGroundedSkill),
    };
  }

  /** Answers explicit questions from a job posting using only verified facts. */
  async generateAnswersForQuestions(
    questions: { question: string; type: string; is_required: boolean }[],
    candidate: CandidateProfile
  ): Promise<QuestionAnswerOutput> {
    const prompt = `
QUESTION_ANSWERING: Answer these job application questions using ONLY candidate verified facts:

CANDIDATE FACTS:
${this.candidateFacts(candidate)}

QUESTIONS TO ANSWER:
${questions.map((q, idx) => `${idx + 1}. [Type: ${q.type}] ${q.question}`).join('\n')}

RULES:
- Answer accurately and concisely.
- For yes/no questions, reply 'Yes' or 'No'.
- Never guess factual numbers or dates. Use the verified candidate facts.

Return ONLY this JSON object:
{ "answers": [{ "question": string, "answer": string, "is_factual": boolean, "source_field": string, "confidence_score": number between 0 and 1 }] }
`;

    const systemInstruction = `You are an automated job application assistant. Generate truthful, concise, and professional answers derived exclusively from verified candidate information.`;

    return this.executeStructuredTask<QuestionAnswerOutput>(
      'question_answering',
      prompt,
      QuestionAnswerSchema,
      systemInstruction,
      undefined,
      () => answerQuestionsDeterministic(questions, candidate)
    );
  }

  private candidateFacts(candidate: CandidateProfile): string {
    const recent = candidate.experience.find((e) => e.is_current) || candidate.experience[0];
    return [
      `- Full Name: ${candidate.full_name}`,
      `- Email: ${candidate.email}`,
      `- Phone: ${candidate.phone}`,
      `- Location: ${candidate.location}`,
      `- Total Years Experience: ${candidate.years_of_experience}`,
      `- Current Role: ${recent ? `${recent.role} at ${recent.company}` : 'Not specified'}`,
      `- Notice Period: ${candidate.notice_period_days} days`,
      `- Current CTC: ${candidate.current_ctc || 'Not specified'}`,
      `- Salary Expectation: ${candidate.salary_expectation || 'Not specified'}`,
      `- Work Mode Preference: ${candidate.work_mode_preference}`,
      `- Willing to relocate: ${candidate.willing_to_relocate ? 'Yes' : 'No'}`,
      `- Authorized to work: ${candidate.work_authorized === false ? 'No' : 'Yes'}`,
      `- Requires visa sponsorship: ${candidate.requires_sponsorship ? 'Yes' : 'No'}`,
      `- Education: ${candidate.education.map((e) => `${e.degree} ${e.field_of_study} from ${e.institution} (${e.end_year || ''})`).join('; ')}`,
      `- Skills: ${candidate.skills.map((s) => `${s.name} (${s.years_experience}y, ${s.proficiency})`).join(', ')}`,
      `- Languages: ${(candidate.languages || []).join(', ')}`,
      `- LinkedIn: ${candidate.linkedin_url || 'none'} | GitHub: ${candidate.github_url || 'none'} | Portfolio: ${candidate.portfolio_url || 'none'}`,
      `- Summary: ${candidate.professional_summary}`,
    ].join('\n');
  }

  /**
   * Answers one application-form question with the AI, grounded in the profile.
   * Returns null when there is no provider, the AI is not confident, or the
   * answer does not fit the field's options.
   */
  async answerFormQuestion(
    ctx: QuestionContext,
    candidate: CandidateProfile,
    job?: NormalizedJob
  ): Promise<{ answer: string; confidence: number } | null> {
    if (!this.provider) return null;
    const options = (ctx.options || []).filter(Boolean);
    const prompt = `
FORM_QUESTION: Answer one job application form field for the candidate.

JOB: ${job ? `${job.title} at ${job.company} (${job.locations.join(', ')})` : 'Not specified'}
JOB DESCRIPTION EXCERPT: ${job ? job.description.slice(0, 1500) : ''}

CANDIDATE FACTS:
${this.candidateFacts(candidate)}

FIELD:
Question/label: ${ctx.question}
Field type: ${ctx.kind || 'text'}
Required: ${ctx.required ? 'yes' : 'no'}
${options.length ? `Allowed options (answer must be exactly one of these): ${JSON.stringify(options.slice(0, 60))}` : ''}

RULES:
- Use only the candidate facts. Never invent employers, degrees, certifications, numbers or dates.
- For "do you have experience with X" questions answer "No" when X is not in the candidate's skills.
- For numeric fields answer with digits only.
- For open questions (motivation, why this company) write 2-4 sentences grounded in the facts and the job.
- Set confidence below 0.5 when the facts do not determine the answer (for example personal preferences not in the facts).
Return JSON: {"answer": string, "confidence": number between 0 and 1}
`;

    try {
      const result = await this.executeStructuredTask(
        'form_question',
        prompt,
        FormAnswerSchema,
        'You fill job application forms truthfully for a candidate. Output only JSON.',
        `formq:${candidate.id}:${job?.id || 'none'}:${candidate.updated_at}`
      );
      if (!result.answer || result.confidence < 0.5) return null;
      if (options.length) {
        const picked = pickOption(options, result.answer);
        return picked ? { answer: picked, confidence: result.confidence } : null;
      }
      return { answer: result.answer.trim(), confidence: result.confidence };
    } catch (err: any) {
      logger.warn({ err: err.message?.slice(0, 200) }, 'AI form question answering failed');
      return null;
    }
  }

  /** Cover letter grounded in the profile; falls back to a composed template. */
  async generateCoverLetter(candidate: CandidateProfile, job: NormalizedJob): Promise<string> {
    const fallback = () => ({ cover_letter: composeCoverLetter(candidate, job) });
    const prompt = `
COVER_LETTER: Write a concise cover letter (150-250 words) for this application.

JOB: ${job.title} at ${job.company}
JOB DESCRIPTION EXCERPT: ${job.description.slice(0, 2500)}

CANDIDATE FACTS:
${this.candidateFacts(candidate)}
Recent achievements: ${candidate.experience.flatMap((e) => e.bullets.slice(0, 2)).slice(0, 5).join(' | ')}

RULES: Use only the facts above. No invented metrics, employers or skills. Plain text, no placeholders like [Company].
Return JSON: {"cover_letter": string}
`;
    const result = await this.executeStructuredTask(
      'cover_letter',
      prompt,
      CoverLetterSchema,
      'You write truthful, specific cover letters. Output only JSON.',
      `cover:${candidate.id}:${job.id}:${candidate.updated_at}`,
      fallback
    );
    return result.cover_letter;
  }

  /** Extracts a candidate profile from raw resume text. */
  async extractProfileFromResume(resumeText: string): Promise<ResumeExtractionOutput> {
    const prompt = `
RESUME_EXTRACTION: Extract all structured information from this resume document into the CandidateProfile schema.

RAW RESUME TEXT:
"""
${resumeText.slice(0, 15000)}
"""

STRICT EXTRACTION RULES (DO NOT USE DUMMY OR PLACEHOLDER DATA):
1. Extract candidate's REAL full name from the document header or contact lines. Never use a placeholder name.
2. Extract real email, phone, location, and online links (LinkedIn, GitHub, Portfolio). If any contact item is missing from text, set to empty string "".
3. Extract professional summary or career objective exactly as expressed in the text. If none, leave empty string "".
4. Extract all technical and domain skills mentioned or demonstrated in the resume into categorized buckets and a flat list of skills.
5. Extract work experience entries with actual company name, job title, employment period/dates, location, bullet points, and key technologies used from the text. If no experience is in text, set to empty array [].
6. Extract education entries with actual institution, degree, field of study, and graduation year. If no education is in text, set to empty array [].
7. Extract projects and certifications if present. If not present, set to empty array [].
8. Compute years_of_experience accurately from the earliest employment start date to the latest date. If none, set to 0.
9. If information is missing, leave it empty. Never fill gaps with example or fictional values.

Return ONLY this JSON object:
{
  "full_name": string, "email": string, "phone": string, "location": string,
  "professional_summary": string, "years_of_experience": number, "salary_expectation": string, "notice_period_days": number,
  "skills": [string],
  "skills_categorized": { "languages": [string], "frameworks": [string], "databases": [string], "cloud_devops": [string], "tools": [string] },
  "experience": [{ "company": string, "role": string, "period": string, "location": string, "bullets": [string], "technologies": [string] }],
  "education": [{ "institution": string, "degree": string, "field_of_study": string, "graduation_year": string, "gpa": string }],
  "projects": [{ "title": string, "description": string, "bullets": [string], "technologies": [string], "link": string }],
  "certifications": [string],
  "linkedin_url": string, "github_url": string, "portfolio_url": string
}
`;

    const systemInstruction = `You are a precision resume extraction engine. Parse the candidate's real resume text into structured JSON strictly matching the schema. NEVER use dummy, placeholder, or hallucinated values. Leave missing sections empty. Output pure JSON.`;

    const heuristic = () => extractStructuredResumeFromText(resumeText);
    const output = await this.executeStructuredTask<ResumeExtractionOutput>(
      'resume_extraction',
      prompt,
      ResumeExtractionSchema,
      systemInstruction,
      undefined,
      heuristic
    );

    // Fill gaps the AI left with what the heuristic parser can find in the text
    if (!output.full_name || output.skills.length === 0) {
      const h = heuristic();
      return {
        ...output,
        full_name: output.full_name || h.full_name,
        email: output.email || h.email,
        phone: output.phone || h.phone,
        location: output.location || h.location,
        skills: output.skills.length > 0 ? output.skills : h.skills,
        skills_categorized: output.skills.length > 0 ? output.skills_categorized : h.skills_categorized,
        experience: output.experience.length > 0 ? output.experience : h.experience,
        education: output.education.length > 0 ? output.education : h.education,
        linkedin_url: output.linkedin_url || h.linkedin_url,
        github_url: output.github_url || h.github_url,
        portfolio_url: output.portfolio_url || h.portfolio_url,
      };
    }

    return output;
  }
}

export const aiService = new AIService();
