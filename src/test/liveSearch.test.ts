import { describe, it, expect } from 'vitest';
import { liveJobSearchService } from '../automation/liveSearch/liveSearchService.js';
import { matchingEngine } from '../matching/matchingEngine.js';
import { initialProfile } from '../db/seed.js';
import type { NormalizedJob } from '../types/index.js';

describe('Live Job Search & Verification Suite', () => {
  it('should list all registered job sources with availability status', () => {
    const sources = liveJobSearchService.getSources();
    expect(sources.length).toBeGreaterThanOrEqual(15);
    
    const ids = sources.map((s) => s.id);
    expect(ids).toContain('LinkedIn');
    expect(ids).toContain('Naukri');
    expect(ids).toContain('Indeed');
    expect(ids).toContain('Internshala');
    expect(ids).toContain('Foundit');
    expect(ids).toContain('TimesJobs');
    expect(ids).toContain('Cutshort');
    expect(ids).toContain('Instahyre');
    expect(ids).toContain('Wellfound');
    expect(ids).toContain('Glassdoor');
    expect(ids).toContain('BulkDrives');
  });

  it('should deduplicate same job across multiple portals into single unified result with source links', () => {
    const jobA: NormalizedJob = {
      id: 'job-1',
      external_id: 'naukri-123',
      platform: 'Naukri',
      title: 'Full Stack Developer',
      company: 'Acme Technologies',
      locations: ['Noida', 'Delhi NCR'],
      work_mode: 'Hybrid',
      experience_required: '0-2 Yrs',
      salary: '₹6,00,000 - ₹8,00,000',
      description: 'Building React and Node applications',
      requirements: ['React', 'Node.js'],
      skills: ['React', 'Node.js'],
      application_url: 'https://naukri.com/job/123',
      created_at: new Date().toISOString(),
      sources: [{ platform: 'Naukri', url: 'https://naukri.com/job/123' }],
    };

    const jobB: NormalizedJob = {
      id: 'job-2',
      external_id: 'linkedin-456',
      platform: 'LinkedIn',
      title: 'Full Stack Developer',
      company: 'Acme Technologies',
      locations: ['Noida'],
      work_mode: 'Hybrid',
      experience_required: '0-2 Yrs',
      salary: '₹6,00,000 - ₹8,00,000',
      description: 'Building React and Node applications',
      requirements: ['React', 'Node.js'],
      skills: ['React', 'Node.js'],
      application_url: 'https://linkedin.com/jobs/view/456',
      created_at: new Date().toISOString(),
      sources: [{ platform: 'LinkedIn', url: 'https://linkedin.com/jobs/view/456' }],
    };

    const deduplicated = liveJobSearchService.deduplicateJobs([jobA, jobB]);
    expect(deduplicated.length).toBe(1);
    expect(deduplicated[0].sources?.length).toBe(2);
    const platforms = deduplicated[0].sources?.map((s) => s.platform);
    expect(platforms).toContain('Naukri');
    expect(platforms).toContain('LinkedIn');
  });

  it('should accurately calculate match score for fresher candidate with BCA eligibility', () => {
    const fresherProfile = {
      ...initialProfile,
      education: [
        {
          id: 'edu-1',
          degree: 'Bachelor of Computer Applications (BCA)',
          institution: 'Delhi University',
          field_of_study: 'Computer Applications',
          start_year: 2021,
          end_year: 2024,
        },
      ],
      skills: [
        { id: 'sk-1', name: 'Java', category: 'Technical' as const, proficiency: 'Intermediate' as const, years_experience: 1 },
        { id: 'sk-2', name: 'Spring Boot', category: 'Technical' as const, proficiency: 'Beginner' as const, years_experience: 1 },
        { id: 'sk-3', name: 'React', category: 'Technical' as const, proficiency: 'Intermediate' as const, years_experience: 1 },
        { id: 'sk-4', name: 'Node.js', category: 'Technical' as const, proficiency: 'Intermediate' as const, years_experience: 1 },
        { id: 'sk-5', name: 'PostgreSQL', category: 'Technical' as const, proficiency: 'Intermediate' as const, years_experience: 1 },
      ],
      preferences: {
        ...initialProfile.preferences,
        preferred_locations: ['Noida', 'Delhi NCR', 'Gurugram'],
      },
    };

    const fresherJob: NormalizedJob = {
      id: 'job-fresher-1',
      external_id: 'job-fresher-1',
      platform: 'Internshala',
      title: 'Junior Java & Spring Boot Developer (Fresher)',
      company: 'Apex Cloud Solutions',
      locations: ['Noida', 'Delhi NCR'],
      work_mode: 'Remote',
      experience_required: '0 - 1 Yr',
      min_experience_years: 0,
      max_experience_years: 1,
      salary: '₹5,00,000 / year',
      education_required: ['BCA', 'MCA', 'B.Tech'],
      description: 'Hiring fresher Java & Spring Boot developers with knowledge of SQL and React.',
      requirements: ['BCA or B.Tech graduates eligible', 'Good command of Java, Spring Boot, React, and SQL'],
      skills: ['Java', 'Spring Boot', 'React', 'PostgreSQL'],
      application_url: 'https://example.com/apply',
      created_at: new Date().toISOString(),
    };

    const match = matchingEngine.calculateMatch(fresherProfile, fresherJob);
    expect(match.overall_match_score).toBeGreaterThanOrEqual(70);
    expect(match.skill_match_score).toBeGreaterThanOrEqual(75);
    expect(match.location_match_score).toBeGreaterThanOrEqual(70);
    expect(match.matched_skills).toContain('Java');
    expect(match.matched_skills).toContain('Spring Boot');
    expect(match.matched_skills).toContain('React');
  });

  it('should mark inaccessible/invalid URLs as unverified or closed rather than confirmed live', async () => {
    // Check against an invalid local host/port that refuses connection
    const result = await liveJobSearchService.verifyJobFreshness('http://127.0.0.1:59999/nonexistent-link-999');
    expect(result.status).not.toBe('verified_live');
    expect(result.is_accessible).toBe(false);
  });
});
