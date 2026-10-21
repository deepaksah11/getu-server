import { CandidateProfile, CandidateSkill, MasterResumeContent } from '../types/index.js';
import { formatPeriod } from '../ai/deterministicEngine.js';

const CATEGORY_LABEL: Record<CandidateSkill['category'], string> = {
  Technical: 'Technical Skills',
  Framework: 'Frameworks & Libraries',
  Tool: 'Tools & Platforms',
  Soft: 'Professional Skills',
};

/**
 * Rebuilds the master resume from the profile, which is the source of truth.
 * Skill groups from the previous master (e.g. "Languages", "Databases" from a
 * parsed resume) are kept for skills that are still in the profile.
 */
export function masterContentFromProfile(profile: CandidateProfile, previous?: MasterResumeContent): MasterResumeContent {
  const profileSkills = profile.skills.map((s) => s.name.trim()).filter(Boolean);
  const remaining = new Set(profileSkills.map((s) => s.toLowerCase()));

  const groups: { category: string; items: string[] }[] = [];
  for (const group of previous?.skills || []) {
    const items = group.items.filter((item) => remaining.has(item.trim().toLowerCase()));
    items.forEach((item) => remaining.delete(item.trim().toLowerCase()));
    if (items.length) groups.push({ category: group.category, items });
  }
  for (const skill of profile.skills) {
    const key = skill.name.trim().toLowerCase();
    if (!remaining.has(key)) continue;
    remaining.delete(key);
    const label = CATEGORY_LABEL[skill.category] || 'Technical Skills';
    const group = groups.find((g) => g.category === label);
    if (group) group.items.push(skill.name.trim());
    else groups.push({ category: label, items: [skill.name.trim()] });
  }

  return {
    summary: profile.professional_summary || '',
    skills: groups,
    experience: profile.experience.map((e) => ({
      company: e.company,
      role: e.role,
      period: formatPeriod(e),
      location: e.location,
      bullets: e.bullets,
      technologies: e.technologies,
    })),
    projects: profile.projects.map((p) => ({
      title: p.title,
      description: p.description,
      bullets: p.bullets,
      technologies: p.technologies,
      link: p.url,
    })),
    education: profile.education.map((ed) => ({
      institution: ed.institution,
      degree: [ed.degree, ed.field_of_study].filter(Boolean).join(' in '),
      year: ed.start_year && ed.end_year ? `${ed.start_year} - ${ed.end_year}` : String(ed.end_year || ed.start_year || ''),
      details: ed.grade ? `Grade: ${ed.grade}` : undefined,
    })),
    certifications: profile.certifications || [],
    achievements: profile.achievements || [],
  };
}
