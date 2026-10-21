import { CandidateProfile, JobMatch, NormalizedJob } from '../types/index.js';
import { extractSkillsFromText, skillsEquivalent, textMentionsSkill } from '../ai/skillDictionary.js';
import { locationMatches, titleMatchScore } from '../automation/platforms/shared.js';

export interface MatchingWeights {
  skills: number;
  experience: number;
  education: number;
  location: number;
  title: number;
}

export const DEFAULT_WEIGHTS: MatchingWeights = {
  skills: 0.35,
  experience: 0.25,
  education: 0.15,
  location: 0.15,
  title: 0.10,
};

export class MatchingEngine {
  private weights: MatchingWeights;

  constructor(weights: MatchingWeights = DEFAULT_WEIGHTS) {
    this.weights = weights;
  }

  /**
   * @param extraRoles target roles from the user's preferences / search keywords,
   *                   counted as "preferred roles" for title relevance
   */
  public calculateMatch(candidate: CandidateProfile, job: NormalizedJob, extraRoles: string[] = []): Omit<JobMatch, 'id' | 'created_at'> {
    // 1. Skill Match Calculation
    const jobSkills =
      job.skills.length > 0
        ? job.skills
        : job.requirements.length > 0
          ? job.requirements
          : extractSkillsFromText(`${job.title}\n${job.description}`);

    const matchedSkills: string[] = [];
    const missingSkills: string[] = [];

    for (const reqSkill of jobSkills) {
      const hasMatch = candidate.skills.some(
        (cs) => skillsEquivalent(cs.name, reqSkill) || textMentionsSkill(reqSkill, cs.name)
      );
      if (hasMatch) {
        matchedSkills.push(reqSkill);
      } else {
        missingSkills.push(reqSkill);
      }
    }

    // Unknown requirements are neutral rather than a near-perfect match
    const skillScore =
      jobSkills.length > 0
        ? Math.min(100, Math.round((matchedSkills.length / jobSkills.length) * 100))
        : 60;

    // 2. Experience Match
    let requiredYears = job.min_experience_years ?? 0;
    if (requiredYears === 0) {
      const expMatch = job.experience_required.match(/(\d+)/);
      if (expMatch) {
        requiredYears = parseInt(expMatch[1], 10);
      }
    }

    const isFresherJob =
      requiredYears === 0 ||
      job.recruitment_type === 'fresher_drive' ||
      job.recruitment_type === 'bulk_hiring' ||
      /fresher|entry level|trainee|0 - 1|0-1|0 to 1/i.test(
        `${job.experience_required} ${job.title}`
      );

    let experienceScore = 100;
    if (isFresherJob) {
      // Fresher-friendly jobs match freshers and early career engineers perfectly
      experienceScore = candidate.years_of_experience <= 2 ? 100 : 85;
    } else if (requiredYears > 0) {
      if (candidate.years_of_experience >= requiredYears) {
        experienceScore = 100;
      } else {
        const ratio = candidate.years_of_experience / requiredYears;
        experienceScore = Math.max(40, Math.round(ratio * 100));
      }
    }

    // 3. Education Match (including BCA, B.Tech, MCA, B.Sc)
    let educationScore = 80;
    const candidateDegrees = candidate.education.map((e) => `${e.degree} ${e.field_of_study}`.toLowerCase());
    const requiredDegrees = (job.education_required || []).map((e) => e.toLowerCase());

    if (requiredDegrees.length > 0) {
      const matchesDegree = requiredDegrees.some((req) =>
        candidateDegrees.some((cand) => cand.includes(req) || req.includes('any graduate'))
      );
      educationScore = matchesDegree ? 98 : 75;
    } else if (candidate.education.length > 0) {
      educationScore = 95;
    }

    // 4. Location Match
    let locationScore = 60;
    const jobIsRemote = job.work_mode.toLowerCase() === 'remote';
    const candidateWantsRemote = candidate.preferred_locations.some((l) => l.toLowerCase() === 'remote');
    const homeCity = (candidate.location || '').split(',')[0].replace(/\(.*\)/, '').trim().toLowerCase();

    // Check for Delhi NCR inclusion
    const isDelhiNCR =
      homeCity.includes('delhi') ||
      homeCity.includes('ncr') ||
      homeCity.includes('noida') ||
      homeCity.includes('gurugram') ||
      homeCity.includes('faridabad') ||
      homeCity.includes('ghaziabad');

    if (jobIsRemote) {
      locationScore = 100;
    } else if (locationMatches(job.locations, candidate.preferred_locations.filter((l) => l.toLowerCase() !== 'remote'))) {
      locationScore = candidate.preferred_locations.length > 0 ? 95 : 60;
    } else if (
      isDelhiNCR &&
      job.locations.some((l) => /delhi|ncr|noida|gurugram|gurgaon|faridabad|ghaziabad/i.test(l))
    ) {
      locationScore = 95;
    } else if (homeCity && locationMatches(job.locations, [homeCity])) {
      locationScore = 90;
    } else if (candidate.willing_to_relocate) {
      locationScore = 75;
    } else if (candidateWantsRemote && job.work_mode.toLowerCase() === 'hybrid') {
      locationScore = 65;
    }

    // 5. Title Relevance Match
    const roles = [...candidate.preferred_roles, ...extraRoles].filter(Boolean);
    const bestRoleScore = roles.length ? Math.max(...roles.map((r) => titleMatchScore(job.title, r))) : 0.5;
    const titleScore = Math.min(100, Math.round(bestRoleScore * 60 + 40));

    // Weighted Overall Score
    let overallScore = Math.round(
      skillScore * this.weights.skills +
        experienceScore * this.weights.experience +
        educationScore * this.weights.education +
        locationScore * this.weights.location +
        titleScore * this.weights.title
    );

    // If core skill coverage is below 50%, penalize overall score accordingly
    if (skillScore < 50) {
      overallScore = Math.min(overallScore, Math.round(skillScore * 1.4 + 15));
    }

    return {
      user_id: candidate.user_id,
      job_id: job.id,
      overall_match_score: overallScore,
      skill_match_score: skillScore,
      experience_match_score: experienceScore,
      education_match_score: educationScore,
      location_match_score: locationScore,
      title_match_score: titleScore,
      is_eligible: true, // Will be filtered through EligibilityChecker
      matched_skills: matchedSkills,
      missing_skills: missingSkills,
      match_breakdown: {
        weights: {
          skills: this.weights.skills,
          experience: this.weights.experience,
          education: this.weights.education,
          location: this.weights.location,
          title: this.weights.title,
        },
        details: {
          skills: `${matchedSkills.length}/${jobSkills.length} required skills matched (${skillScore}%)`,
          experience: `Candidate has ${candidate.years_of_experience} yrs vs required ${job.experience_required} (${experienceScore}%)`,
          education: `${candidate.education[0]?.degree || 'Relevant degree'} verified (${educationScore}%)`,
          location: `${job.work_mode} / ${job.locations.join(', ')} (${locationScore}%)`,
          title: `Role alignment with preferred roles (${titleScore}%)`,
        },
      },
    };
  }
}

export const matchingEngine = new MatchingEngine();
