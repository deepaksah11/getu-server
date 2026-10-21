import {
  CandidateExperience,
  CandidateProfile,
  MasterResume,
  NormalizedJob,
} from '../types/index.js';
import { JobAnalysisOutput, QuestionAnswerOutput, ResumeTailoringOutput } from './schemas.js';
import { extractSkillsFromText, skillsEquivalent, textMentionsSkill } from './skillDictionary.js';
import { answerFromProfile } from './answerRules.js';

/**
 * Offline implementations of the AI tasks. They only reorganise facts that are
 * already in the job posting or the candidate profile; nothing is invented.
 */

const SOFT_SKILLS = [
  'communication', 'leadership', 'teamwork', 'collaboration', 'problem solving', 'ownership',
  'mentoring', 'stakeholder management', 'time management', 'adaptability', 'critical thinking',
];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function dedupeSkills(skills: string[]): string[] {
  const out: string[] = [];
  for (const s of skills) {
    const trimmed = s.trim();
    if (trimmed && !out.some((o) => skillsEquivalent(o, trimmed))) out.push(trimmed);
  }
  return out;
}

function stripHtml(text: string): string {
  return text.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

export function analyzeJobDeterministic(job: NormalizedJob): JobAnalysisOutput {
  const description = stripHtml(job.description || '');
  const fullText = [job.title, description, ...(job.requirements || [])].join('\n');

  const preferredSection =
    fullText.match(/(nice[- ]to[- ]have|preferred|bonus|good[- ]to[- ]have|is a plus|would be a plus)[\s\S]{0,700}/i)?.[0] || '';
  const preferredOnly = extractSkillsFromText(preferredSection).filter(
    (s) => !(job.skills || []).some((js) => skillsEquivalent(js, s))
  );
  const allMentioned = dedupeSkills([...(job.skills || []), ...extractSkillsFromText(fullText, job.skills || [])]);
  const required = allMentioned.filter((s) => !preferredOnly.some((p) => skillsEquivalent(p, s)));

  const expMatch = fullText.match(/(\d+)\s*(?:\+|plus)?\s*(?:-|–|to)?\s*(\d+)?\s*(?:\+)?\s*(?:years|yrs)/i);
  const experience =
    job.experience_required && job.experience_required !== 'Not specified'
      ? job.experience_required
      : expMatch
        ? expMatch[2]
          ? `${expMatch[1]}-${expMatch[2]} years`
          : `${expMatch[1]}+ years`
        : 'Not specified';

  const eduMatch = fullText.match(
    /(bachelor'?s?|master'?s?|b\.?\s?tech|m\.?\s?tech|b\.?e\.?|b\.?sc|m\.?sc|mba|mca|bca|ph\.?d)[^.\n]{0,80}/i
  );

  const sentences = description
    .split(/\n|(?<=[.!?])\s+|•|·/)
    .map((s) => s.replace(/^[-*\s]+/, '').trim())
    .filter((s) => s.length > 25 && s.length < 260);
  const responsibilities = sentences
    .filter((s) => /^(build|design|develop|lead|own|work|collaborate|implement|maintain|create|drive|manage|write|deliver|support|partner|ensure|improve|define|mentor|analy[sz]e|research|optimi[sz]e|test|deploy)/i.test(s))
    .slice(0, 6);

  const textLower = fullText.toLowerCase();
  let workMode: string = job.work_mode;
  if (!['Remote', 'Hybrid', 'Onsite'].includes(workMode)) {
    if (/\bremote\b|work from home|wfh/.test(textLower)) workMode = 'Remote';
    else if (/\bhybrid\b/.test(textLower)) workMode = 'Hybrid';
    else if (/on-?site|in office|work from office/.test(textLower)) workMode = 'Onsite';
    else workMode = 'Flexible';
  }

  return {
    job_title: job.title,
    required_skills: required,
    preferred_skills: preferredOnly,
    experience_required: experience,
    education_required: eduMatch ? eduMatch[0].trim() : 'Not specified',
    responsibilities: responsibilities.length ? responsibilities : sentences.slice(0, 4),
    technical_requirements: required,
    soft_skills: SOFT_SKILLS.filter((s) => textLower.includes(s)),
    location: job.locations || [],
    work_mode: workMode as JobAnalysisOutput['work_mode'],
    salary_range: job.salary || 'Not specified',
    eligibility_notes: '',
    keywords: dedupeSkills([...required, ...preferredOnly]).slice(0, 20),
    // Questions are only reported when the posting really asks them (AI path); never invented here
    detected_questions: [],
  };
}

export function formatPeriod(exp: Pick<CandidateExperience, 'start_date' | 'end_date' | 'is_current'>): string {
  const fmt = (value?: string): string => {
    if (!value) return '';
    const iso = value.match(/^(\d{4})-(\d{2})/);
    if (iso) return `${MONTHS[parseInt(iso[2], 10) - 1] || ''} ${iso[1]}`.trim();
    return value;
  };
  const start = fmt(exp.start_date);
  const end = exp.is_current ? 'Present' : fmt(exp.end_date);
  return [start, end].filter(Boolean).join(' - ');
}

function relevance(text: string, required: string[], preferred: string[]): number {
  let score = 0;
  for (const s of required) if (textMentionsSkill(text, s)) score += 2;
  for (const s of preferred) if (textMentionsSkill(text, s)) score += 1;
  return score;
}

/** Stable sort by score, keeping the original order for ties. */
function sortByScore<T>(items: T[], score: (item: T) => number): T[] {
  return items
    .map((item, index) => ({ item, index, s: score(item) }))
    .sort((a, b) => b.s - a.s || a.index - b.index)
    .map((x) => x.item);
}

export function tailorResumeDeterministic(
  candidate: CandidateProfile,
  masterResume: MasterResume,
  job: NormalizedJob,
  analysis: JobAnalysisOutput
): ResumeTailoringOutput {
  const required = dedupeSkills([...analysis.required_skills, ...(job.skills || [])]);
  const preferred = dedupeSkills([...analysis.preferred_skills, ...analysis.keywords]).filter(
    (s) => !required.some((r) => skillsEquivalent(r, s))
  );
  const target = [...required, ...preferred];
  const isTarget = (skill: string) => target.some((t) => skillsEquivalent(t, skill));

  // Skills: the profile's skills only (master groups just provide category names), JD matches first
  const master = masterResume.content_json;
  let skillGroups: { category: string; items: string[] }[];
  if (master.skills?.length && candidate.skills.length) {
    const owned = (name: string) => candidate.skills.some((s) => skillsEquivalent(s.name, name));
    skillGroups = master.skills.map((g) => ({ category: g.category, items: g.items.filter(owned) }));
    const listed = skillGroups.flatMap((g) => g.items);
    const missing = candidate.skills.map((s) => s.name).filter((n) => !listed.some((l) => skillsEquivalent(l, n)));
    if (missing.length) skillGroups.push({ category: 'Additional Skills', items: missing });
  } else if (master.skills?.length) {
    skillGroups = master.skills.map((g) => ({ category: g.category, items: [...g.items] }));
  } else {
    const byCategory = new Map<string, string[]>();
    for (const s of candidate.skills) {
      const label =
        s.category === 'Framework' ? 'Frameworks & Libraries' : s.category === 'Tool' ? 'Tools & Platforms' : s.category === 'Soft' ? 'Professional Skills' : 'Technical Skills';
      byCategory.set(label, [...(byCategory.get(label) || []), s.name]);
    }
    skillGroups = Array.from(byCategory.entries()).map(([category, items]) => ({ category, items }));
  }
  skillGroups = sortByScore(
    skillGroups
      .map((g) => ({ category: g.category, items: sortByScore(g.items, (i) => (isTarget(i) ? 1 : 0)) }))
      .filter((g) => g.items.length > 0),
    (g) => g.items.filter(isTarget).length
  );

  // Experience: from the profile (source of truth); bullets most relevant to the JD first
  const experienceSource =
    candidate.experience.length > 0
      ? candidate.experience.map((e) => ({
          company: e.company,
          role: e.role,
          period: formatPeriod(e),
          location: e.location,
          bullets: e.bullets || [],
          technologies: e.technologies || [],
        }))
      : master.experience || [];
  const tailoredExperience = experienceSource.map((e) => ({
    company: e.company,
    role: e.role,
    period: e.period,
    location: e.location,
    bullets: sortByScore(e.bullets, (b) => relevance(b, required, preferred)),
    technologies: sortByScore(e.technologies, (t) => (isTarget(t) ? 1 : 0)),
  }));

  const projectSource =
    candidate.projects.length > 0
      ? candidate.projects.map((p) => ({
          title: p.title,
          description: p.description,
          bullets: p.bullets || [],
          technologies: p.technologies || [],
          link: p.url,
        }))
      : master.projects || [];
  const tailoredProjects = sortByScore(
    projectSource.map((p) => ({
      ...p,
      bullets: sortByScore(p.bullets, (b) => relevance(b, required, preferred)),
      technologies: sortByScore(p.technologies, (t) => (isTarget(t) ? 1 : 0)),
    })),
    (p) => relevance([p.title, p.description, ...p.bullets, ...p.technologies].join(' '), required, preferred)
  );

  // Summary: the candidate's own words, plus a line naming their skills that match this job
  const matchedSkills = candidate.skills.filter((s) => isTarget(s.name)).map((s) => s.name);
  const baseSummary = (candidate.professional_summary || master.summary || '').trim();
  const unmentioned = matchedSkills.filter((s) => !textMentionsSkill(baseSummary, s)).slice(0, 5);
  let summary = baseSummary;
  if (!summary) {
    const recent = candidate.experience.find((e) => e.is_current) || candidate.experience[0];
    const years = candidate.years_of_experience ? `${candidate.years_of_experience}+ years of experience` : '';
    summary = [recent ? recent.role : '', years ? `with ${years}` : '', matchedSkills.length ? `in ${matchedSkills.slice(0, 5).join(', ')}` : '']
      .filter(Boolean)
      .join(' ')
      .trim();
    summary = summary ? `${summary.charAt(0).toUpperCase()}${summary.slice(1)}.` : '';
  } else if (unmentioned.length) {
    summary = `${summary}${/[.!?]$/.test(summary) ? '' : '.'} Core strengths include ${unmentioned.join(', ')}.`;
  }

  const resumeText = [
    summary,
    ...skillGroups.flatMap((g) => g.items),
    ...tailoredExperience.flatMap((e) => [...e.bullets, ...e.technologies]),
    ...tailoredProjects.flatMap((p) => [p.description, ...p.bullets, ...p.technologies]),
  ].join(' ');

  return {
    tailored_summary: summary,
    highlighted_skills: skillGroups,
    tailored_experience: tailoredExperience,
    tailored_projects: tailoredProjects,
    keywords_incorporated: target.filter((k) => textMentionsSkill(resumeText, k)),
    rationale: 'Ordered verified skills, bullets and projects by relevance to the job requirements (offline tailoring).',
  };
}

export function answerQuestionsDeterministic(
  questions: { question: string; type: string; is_required: boolean }[],
  candidate: CandidateProfile
): QuestionAnswerOutput {
  const answers = questions
    .map((q) => {
      const ruled = answerFromProfile({ question: q.question, kind: q.type === 'yes_no' ? 'radio' : 'text', options: q.type === 'yes_no' ? ['Yes', 'No'] : undefined }, candidate);
      if (!ruled) return null;
      return {
        question: q.question,
        answer: ruled.answer,
        is_factual: ruled.source === 'candidate_profile',
        source_field: ruled.source,
        confidence_score: ruled.confidence,
      };
    })
    .filter((a): a is NonNullable<typeof a> => a !== null);
  return { answers };
}
