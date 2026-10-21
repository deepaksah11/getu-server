import { describe, it, expect } from 'vitest';
import { matchingEngine } from '../matching/matchingEngine.js';
import { eligibilityChecker } from '../matching/eligibilityChecker.js';
import { initialProfile, initialJobs as seedJobs, initialPreferences } from '../db/seed.js';

// Seed jobs belong to the demo board; these tests model a job on an enabled platform
const initialJobs = seedJobs.map((j) => ({ ...j, platform: 'Greenhouse' }));

describe('Matching Engine & Eligibility Checker', () => {
  it('should calculate high Profile Match score for matching candidate and job', () => {
    const job = initialJobs[0]; // Senior Full Stack Developer (Node.js & React)
    const match = matchingEngine.calculateMatch(initialProfile, job);

    expect(match.overall_match_score).toBeGreaterThanOrEqual(75);
    expect(match.skill_match_score).toBeGreaterThanOrEqual(80);
    expect(match.matched_skills.length).toBeGreaterThan(0);
    expect(match.match_breakdown.weights.skills).toBe(0.35);
  });

  it('should detect missing skills accurately', () => {
    const jobWithRareSkills = {
      ...initialJobs[0],
      skills: ['Cobol 1974', 'Unreal Engine 5', 'Node.js'],
      requirements: ['Cobol 1974', 'Unreal Engine 5', 'Node.js'],
    };

    const match = matchingEngine.calculateMatch(initialProfile, jobWithRareSkills);
    expect(match.missing_skills).toContain('Cobol 1974');
    expect(match.missing_skills).toContain('Unreal Engine 5');
    expect(match.matched_skills).toContain('Node.js');
    expect(match.overall_match_score).toBeLessThan(70);
  });

  it('should mark eligible when match score meets threshold and no exclusions match', () => {
    const job = initialJobs[0];
    const match = matchingEngine.calculateMatch(initialProfile, job);
    const eligibility = eligibilityChecker.checkEligibility(match, job, initialPreferences, 0);

    expect(eligibility.is_eligible).toBe(true);
  });

  it('should reject application if company is in excluded_companies', () => {
    const scamJob = {
      ...initialJobs[0],
      company: 'CryptoScam LLC International',
    };
    const match = matchingEngine.calculateMatch(initialProfile, scamJob);
    const eligibility = eligibilityChecker.checkEligibility(match, scamJob, initialPreferences, 0);

    expect(eligibility.is_eligible).toBe(false);
    expect(eligibility.reason).toContain('matches user exclusion list');
  });

  it('should reject application if JD contains excluded keywords', () => {
    const unpaidJob = {
      ...initialJobs[0],
      description: 'This is an unpaid internship position for software engineers.',
    };
    const match = matchingEngine.calculateMatch(initialProfile, unpaidJob);
    const eligibility = eligibilityChecker.checkEligibility(match, unpaidJob, initialPreferences, 0);

    expect(eligibility.is_eligible).toBe(false);
    expect(eligibility.reason).toContain('contains excluded keyword');
  });

  it('should reject application if daily quota is reached', () => {
    const job = initialJobs[0];
    const match = matchingEngine.calculateMatch(initialProfile, job);
    const eligibility = eligibilityChecker.checkEligibility(
      match,
      job,
      initialPreferences,
      initialPreferences.max_applications_per_day
    );

    expect(eligibility.is_eligible).toBe(false);
    expect(eligibility.reason).toContain('Daily application limit reached');
  });

  it('should accept application when job platform is in user enabled_platforms', () => {
    const job = { ...initialJobs[0], platform: 'Unstop' };
    const match = matchingEngine.calculateMatch(initialProfile, job);
    const prefsWithPlatforms = {
      ...initialPreferences,
      enabled_platforms: ['Unstop', 'LinkedIn'],
    };
    const eligibility = eligibilityChecker.checkEligibility(match, job, prefsWithPlatforms, 0);

    expect(eligibility.is_eligible).toBe(true);
  });

  it('should reject application when job platform is disabled in user preferences (Rule 5)', () => {
    const job = { ...initialJobs[0], platform: 'LinkedIn' };
    const match = matchingEngine.calculateMatch(initialProfile, job);
    const prefsOnlyUnstop = {
      ...initialPreferences,
      enabled_platforms: ['Unstop'], // LinkedIn disabled
    };
    const eligibility = eligibilityChecker.checkEligibility(match, job, prefsOnlyUnstop, 0);

    expect(eligibility.is_eligible).toBe(false);
    expect(eligibility.reason).toContain("not in user's enabled platforms");
  });
});

describe('Matching details', () => {
  it('treats Bangalore and Bengaluru as the same city', () => {
    const job = { ...initialJobs[1], work_mode: 'Onsite', locations: ['Bengaluru, Karnataka, India'] };
    const candidate = { ...initialProfile, preferred_locations: ['Bangalore'] };
    expect(matchingEngine.calculateMatch(candidate, job).location_match_score).toBe(95);
  });

  it('scores unknown job requirements as neutral instead of a near-perfect match', () => {
    const job = { ...initialJobs[0], title: 'Engineer', skills: [], requirements: [], description: 'We are hiring.' };
    expect(matchingEngine.calculateMatch(initialProfile, job).skill_match_score).toBe(60);
  });

  it('does not exclude jobs whose work mode the posting did not state', () => {
    const job = { ...initialJobs[0], work_mode: 'Flexible' };
    const match = matchingEngine.calculateMatch(initialProfile, job);
    const result = eligibilityChecker.checkEligibility(match, job, { ...initialPreferences, work_modes: ['Remote'] }, 0);
    expect(result.is_eligible).toBe(true);
  });
});
