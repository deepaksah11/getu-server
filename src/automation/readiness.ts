import { CandidateProfile, UserPreferences } from '../types/index.js';
import { SearchQuery } from './platforms/types.js';

export interface ProfileReadiness {
  ready: boolean;
  missing: string[];
  warnings: string[];
}

// Names left behind by earlier sample data / placeholder extraction
const PLACEHOLDER_NAMES = /^(jordan lee|alex chen|john doe|jane doe|test user|candidate)$/i;
const PLACEHOLDER_EMAIL = /@(example\.(com|org|net)|test\.com|email\.com)$/i;

/**
 * Applications are sent in the user's name, so automation refuses to start
 * until the profile holds real contact details and enough experience data.
 */
export function profileReadiness(profile: CandidateProfile): ProfileReadiness {
  const missing: string[] = [];
  const warnings: string[] = [];

  if (!profile.full_name?.trim()) missing.push('Full name');
  if (!profile.email?.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.email)) missing.push('Valid email address');
  if (!profile.phone?.replace(/\D/g, '') || profile.phone.replace(/\D/g, '').length < 8) missing.push('Phone number');
  if (!profile.location?.trim()) missing.push('Current location');
  if ((profile.skills || []).length < 3) missing.push('At least 3 skills');
  if ((profile.experience || []).length + (profile.education || []).length + (profile.projects || []).length === 0) {
    missing.push('Work experience, education or projects');
  }
  if (PLACEHOLDER_EMAIL.test(profile.email || '') || (PLACEHOLDER_NAMES.test((profile.full_name || '').trim()) && PLACEHOLDER_EMAIL.test(profile.email || ''))) {
    missing.push('Real contact details (the profile still contains sample data: upload your resume on the Profile page)');
  }

  if (!profile.professional_summary?.trim()) warnings.push('Add a professional summary for better tailored resumes');
  if (!profile.linkedin_url) warnings.push('Add your LinkedIn URL (many forms ask for it)');
  if (!profile.salary_expectation) warnings.push('Set your expected salary (asked by most Indian portals)');
  if (!profile.current_ctc && (profile.years_of_experience || 0) > 0) warnings.push('Set your current CTC');

  return { ready: missing.length === 0, missing, warnings };
}

const NOT_A_PLACE = /^(hybrid|onsite|on-site|in office|office|flexible|any)$/i;

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const t = v.trim();
    if (t && !seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase());
      out.push(t);
    }
  }
  return out;
}

/** Builds the job search from preferences, falling back to the candidate profile. */
export function buildSearchQuery(prefs: UserPreferences, profile: CandidateProfile): SearchQuery {
  let keywords = unique(prefs.search_keywords?.length ? prefs.search_keywords : [...(prefs.preferred_roles || []), ...(profile.preferred_roles || [])]).slice(0, 4);
  if (keywords.length === 0) {
    const recent = profile.experience.find((e) => e.is_current) || profile.experience[0];
    if (recent?.role) keywords = [recent.role];
    else if (profile.skills.length) keywords = [`${profile.skills[0].name} Developer`];
    else keywords = ['Software Engineer'];
  }

  let locations = unique(
    (prefs.search_locations?.length ? prefs.search_locations : [...(prefs.preferred_locations || []), ...(profile.preferred_locations || [])]).filter(
      (l) => !NOT_A_PLACE.test(l.trim())
    )
  ).slice(0, 3);
  if (locations.length === 0) {
    const city = (profile.location || '').split(',')[0].replace(/\(.*\)/, '').trim();
    locations = unique([city, /remote/i.test(profile.work_mode_preference || '') ? 'Remote' : ''].filter(Boolean));
  }

  return {
    keywords,
    locations,
    limit: Math.max(1, Math.min(prefs.jobs_per_platform ?? 15, 50)),
    postedWithinDays: Math.max(1, prefs.posted_within_days ?? 7),
  };
}
