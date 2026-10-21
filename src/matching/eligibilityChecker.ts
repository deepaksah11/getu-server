import { JobMatch, NormalizedJob, UserPreferences } from '../types/index.js';

export interface EligibilityResult {
  is_eligible: boolean;
  reason?: string;
}

export class EligibilityChecker {
  public checkEligibility(
    match: Omit<JobMatch, 'id' | 'created_at'>,
    job: NormalizedJob,
    preferences: UserPreferences,
    dailyApplicationsSubmitted: number = 0
  ): EligibilityResult {
    // 1. Excluded Company Check
    for (const excluded of preferences.excluded_companies) {
      if (
        excluded.trim() &&
        job.company.toLowerCase().includes(excluded.trim().toLowerCase())
      ) {
        return {
          is_eligible: false,
          reason: `Company '${job.company}' matches user exclusion list (${excluded})`,
        };
      }
    }

    // 2. Excluded Keywords Check
    const fullText = `${job.title} ${job.description} ${job.requirements.join(' ')}`.toLowerCase();
    for (const kw of preferences.excluded_keywords) {
      if (kw.trim() && fullText.includes(kw.trim().toLowerCase())) {
        return {
          is_eligible: false,
          reason: `Job description contains excluded keyword: '${kw}'`,
        };
      }
    }

    // 3. Minimum Match Score Check
    if (match.overall_match_score < preferences.minimum_match_score) {
      return {
        is_eligible: false,
        reason: `Overall match score ${match.overall_match_score}% is below configured minimum ${preferences.minimum_match_score}%`,
      };
    }

    // 4. Work Mode Preference Check ("Flexible" = not stated by the posting, so not excluded)
    if (
      preferences.work_modes.length > 0 &&
      job.work_mode.toLowerCase() !== 'flexible' &&
      !preferences.work_modes.some(
        (wm) => wm.toLowerCase() === job.work_mode.toLowerCase()
      )
    ) {
      return {
        is_eligible: false,
        reason: `Job work mode '${job.work_mode}' not in user preferred modes (${preferences.work_modes.join(', ')})`,
      };
    }

    // 5. Target Platform Check
    if (preferences.enabled_platforms && preferences.enabled_platforms.length > 0) {
      const allowed = preferences.enabled_platforms.some((p) => {
        const pLower = p.toLowerCase();
        const jobPLower = job.platform.toLowerCase();
        if (pLower === jobPLower) return true;
        if (
          pLower.includes('direct') &&
          (jobPLower.includes('direct') || jobPLower.includes('portal') || jobPLower.includes('external'))
        )
          return true;
        return false;
      });

      if (!allowed) {
        return {
          is_eligible: false,
          reason: `Job platform '${job.platform}' is not in user's enabled platforms (${preferences.enabled_platforms.join(', ')})`,
        };
      }
    }

    // 6. Daily Application Limit Check
    if (dailyApplicationsSubmitted >= preferences.max_applications_per_day) {
      return {
        is_eligible: false,
        reason: `Daily application limit reached (${dailyApplicationsSubmitted}/${preferences.max_applications_per_day})`,
      };
    }

    return {
      is_eligible: true,
    };
  }
}

export const eligibilityChecker = new EligibilityChecker();
