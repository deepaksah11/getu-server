import { describe, it, expect, beforeEach } from 'vitest';
import { AIService } from '../ai/aiService.js';
import { MockAIProvider } from '../ai/mockProvider.js';
import { JobAnalysisSchema } from '../ai/schemas.js';
import { AIProvider } from '../ai/provider.js';
import { initialProfile, initialJobs, initialMasterResume } from '../db/seed.js';
import { CandidateProfile, MasterResume } from '../types/index.js';
import { testCandidate } from './fixtures.js';

const priya = {
  ...initialProfile,
  ...testCandidate('user-priya'),
  id: 'profile-priya',
  updated_at: '2026-01-01T00:00:00.000Z',
} as CandidateProfile;
const emptyMaster: MasterResume = {
  ...initialMasterResume,
  id: 'master-priya',
  user_id: 'user-priya',
  content_json: { summary: '', skills: [], experience: [], projects: [], education: [], certifications: [], achievements: [] },
};

describe('AI Subsystem & Anti-Hallucination Guardrails', () => {
  let mockProvider: MockAIProvider;
  let aiService: AIService;

  beforeEach(() => {
    mockProvider = new MockAIProvider('valid');
    aiService = new AIService(mockProvider);
  });

  it('analyzes a job description into the validated schema', async () => {
    const analysis = await aiService.analyzeJobDescription(initialJobs[0]);
    expect(analysis.required_skills).toContain('Node.js');
    expect(analysis.required_skills).toContain('TypeScript');
    expect(Array.isArray(analysis.responsibilities)).toBe(true);
    expect(analysis.work_mode).toMatch(/Remote|Hybrid|Onsite|Flexible/);
  });

  it('tailors a resume grounded in the candidate profile', async () => {
    const job = initialJobs[0];
    const analysis = await aiService.analyzeJobDescription(job);
    const tailored = await aiService.tailorResume(initialProfile, initialMasterResume, job, analysis);
    expect(tailored.tailored_summary).toBeTruthy();
    expect(tailored.highlighted_skills.length).toBeGreaterThan(0);
    expect(tailored.tailored_experience.map((e) => e.company)).toEqual(initialProfile.experience.map((e) => e.company));
  });

  it('CRITICAL: strips skills that are not in the profile', async () => {
    mockProvider.setBehavior('hallucinated');
    const job = initialJobs[0];
    const analysis = await aiService.analyzeJobDescription(job);
    const tailored = await aiService.tailorResume(initialProfile, initialMasterResume, job, analysis);
    const allSkills = tailored.highlighted_skills.flatMap((c) => c.items);
    expect(allSkills).not.toContain('Cobol 1974');
    expect(allSkills).not.toContain('Quantum Computing Q#');
    expect(allSkills).not.toContain('Unreal Engine 5');
  });

  it('CRITICAL: removes employers and projects the AI invents for another candidate', async () => {
    // The mock returns Alex Chen's employers; Priya never worked there
    const job = initialJobs[0];
    const analysis = await aiService.analyzeJobDescription(job);
    const tailored = await aiService.tailorResume(priya, emptyMaster, job, analysis);
    const companies = tailored.tailored_experience.map((e) => e.company);
    expect(companies).toEqual(['Acme Analytics']);
    expect(companies).not.toContain('HyperScale Tech');
    expect(tailored.tailored_projects.map((p) => p.title)).toEqual(['Expense Splitter']);
    const skills = tailored.highlighted_skills.flatMap((c) => c.items);
    expect(skills).not.toContain('AWS');
    expect(skills).not.toContain('GraphQL');
  });

  it('keeps company, role and dates from the profile even when the AI rewrites them', async () => {
    const rewriting: AIProvider = {
      name: 'rewriting',
      async generateText(prompt: string) {
        if (prompt.includes('RESUME_TAILORING')) {
          return {
            text: JSON.stringify({
              tailored_summary: 'Engineer.',
              highlighted_skills: [{ category: 'Core', items: ['TypeScript', 'Kubernetes'] }],
              tailored_experience: [
                { company: 'Acme Analytics', role: 'Principal Architect', period: '2015 - Present', bullets: ['Rephrased bullet.'], technologies: ['TypeScript', 'Kubernetes'] },
                { company: 'Google', role: 'Staff Engineer', period: '2010 - 2015', bullets: ['Invented.'], technologies: ['Go'] },
              ],
              tailored_projects: [],
            }),
            inputTokens: 1,
            outputTokens: 1,
            latencyMs: 1,
            model: 'test',
          };
        }
        return { text: '{}', inputTokens: 1, outputTokens: 1, latencyMs: 1, model: 'test' };
      },
    };
    const service = new AIService(rewriting);
    const analysis = await new AIService(null).analyzeJobDescription(initialJobs[0]);
    const tailored = await service.tailorResume(priya, emptyMaster, initialJobs[0], analysis);
    expect(tailored.tailored_experience).toHaveLength(1);
    expect(tailored.tailored_experience[0]).toMatchObject({ company: 'Acme Analytics', role: 'Software Engineer', period: 'Mar 2021 - Present' });
    expect(tailored.tailored_experience[0].bullets).toEqual(['Rephrased bullet.']);
    expect(tailored.tailored_experience[0].technologies).not.toContain('Kubernetes');
    expect(tailored.highlighted_skills.flatMap((c) => c.items)).toEqual(['TypeScript']);
  });

  it('falls back to the deterministic engine when the AI keeps returning malformed JSON', async () => {
    mockProvider.setBehavior('malformed');
    const job = { ...initialJobs[0], id: 'job-fresh-test-01', external_id: 'uncached-ext-test-999' };
    const analysis = await aiService.analyzeJobDescription(job);
    expect(JobAnalysisSchema.safeParse(analysis).success).toBe(true);
    expect(analysis.required_skills).toEqual(expect.arrayContaining(job.skills));
    expect(analysis.detected_questions).toEqual([]);
  });

  it('throws after repair retries when no fallback exists', async () => {
    mockProvider.setBehavior('malformed');
    await expect(
      aiService.executeStructuredTask('test_task', 'prompt', JobAnalysisSchema, 'system')
    ).rejects.toThrow(/failed after/);
  });

  it('answers explicit application questions from verified facts', async () => {
    const questions = [
      { question: 'How many years of experience do you have with Node.js and TypeScript?', type: 'experience', is_required: true },
      { question: 'What is your current notice period?', type: 'notice_period', is_required: true },
    ];
    const result = await aiService.generateAnswersForQuestions(questions, initialProfile);
    expect(result.answers.length).toBe(2);
    expect(result.answers[0].is_factual).toBe(true);
    expect(result.answers[0].answer).toContain('7.5 years');
    expect(result.answers[1].answer).toContain('15 days');
  });

  it('works fully offline without an AI provider', async () => {
    const offline = new AIService(null);
    expect(offline.hasProvider()).toBe(false);
    const job = initialJobs[0];
    const analysis = await offline.analyzeJobDescription(job);
    const tailored = await offline.tailorResume(priya, emptyMaster, job, analysis);
    expect(tailored.tailored_experience.map((e) => e.company)).toEqual(['Acme Analytics']);
    // JD-relevant bullets first
    expect(tailored.tailored_experience[0].bullets[0]).toMatch(/Node\.js|TypeScript/);
    const answers = await offline.generateAnswersForQuestions(
      [{ question: 'What is your notice period?', type: 'notice_period', is_required: true }],
      priya
    );
    expect(answers.answers[0].answer).toBe('30 days');
    const letter = await offline.generateCoverLetter(priya, job);
    expect(letter).toContain('Priya Sharma');
    expect(letter).toContain(job.company);
    expect(letter).not.toMatch(/HyperScale|CloudFlow/);
  });
});

describe('Profile is the source of truth for tailoring', () => {
  it('ignores stale master-resume skills the profile no longer lists', async () => {
    const staleMaster: MasterResume = {
      ...emptyMaster,
      content_json: { ...emptyMaster.content_json, skills: [{ category: 'Cloud', items: ['AWS', 'Kubernetes', 'Docker'] }] },
    };
    const offline = new AIService(null);
    const job = { ...initialJobs[1] };
    const analysis = await offline.analyzeJobDescription(job);
    const tailored = await offline.tailorResume(priya, staleMaster, job, analysis);
    const skills = tailored.highlighted_skills.flatMap((g) => g.items);
    expect(skills).not.toContain('AWS');
    expect(skills).not.toContain('Kubernetes');
    expect(skills).toContain('Docker'); // listed in both
    expect(skills).toEqual(expect.arrayContaining(['TypeScript', 'Node.js']));
  });
});
