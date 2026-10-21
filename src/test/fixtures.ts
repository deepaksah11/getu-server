import { CandidateProfile } from '../types/index.js';

/** A complete, realistic candidate used by the end-to-end tests (not sample data). */
export function testCandidate(userId: string): Partial<CandidateProfile> {
  return {
    user_id: userId,
    full_name: 'Priya Sharma',
    email: 'priya.sharma@testmail.dev',
    phone: '+91 98765 43210',
    location: 'Bengaluru, Karnataka, India',
    professional_summary:
      'Software engineer with 4 years of experience building TypeScript and Node.js services and React front ends for analytics products.',
    years_of_experience: 4,
    notice_period_days: 30,
    salary_expectation: '18 LPA',
    current_ctc: '12 LPA',
    work_mode_preference: 'Remote or Hybrid',
    preferred_roles: ['Full Stack Engineer', 'Backend Engineer', 'Software Engineer'],
    preferred_locations: ['Remote', 'Bengaluru'],
    languages: ['English', 'Hindi'],
    certifications: [],
    achievements: [],
    linkedin_url: 'https://linkedin.com/in/priya-sharma-dev',
    github_url: 'https://github.com/priyasharma-dev',
    portfolio_url: undefined,
    gender: undefined,
    work_authorized: true,
    requires_sponsorship: false,
    willing_to_relocate: false,
    skills: [
      { name: 'TypeScript', category: 'Technical', proficiency: 'Advanced', years_experience: 4 },
      { name: 'Node.js', category: 'Technical', proficiency: 'Advanced', years_experience: 4 },
      { name: 'React', category: 'Framework', proficiency: 'Advanced', years_experience: 3 },
      { name: 'PostgreSQL', category: 'Technical', proficiency: 'Intermediate', years_experience: 3 },
      { name: 'Docker', category: 'Tool', proficiency: 'Intermediate', years_experience: 2 },
      { name: 'Redis', category: 'Technical', proficiency: 'Intermediate', years_experience: 2 },
    ],
    experience: [
      {
        company: 'Acme Analytics',
        role: 'Software Engineer',
        location: 'Bengaluru',
        start_date: '2021-03-01',
        is_current: true,
        bullets: [
          'Built Node.js and TypeScript APIs serving dashboards for 2,000 business users.',
          'Introduced Redis caching that cut report latency from 4s to 900ms.',
          'Shipped React components for the self-serve analytics editor.',
        ],
        technologies: ['TypeScript', 'Node.js', 'React', 'PostgreSQL', 'Redis'],
      },
    ],
    projects: [
      {
        title: 'Expense Splitter',
        description: 'Open-source React and Node.js app for splitting group expenses.',
        technologies: ['React', 'Node.js', 'PostgreSQL'],
        bullets: ['Used by 300+ people; Docker-based deployment.'],
      },
    ],
    education: [
      {
        institution: 'Visvesvaraya Technological University',
        degree: 'B.E.',
        field_of_study: 'Computer Science',
        start_year: 2017,
        end_year: 2021,
        grade: '8.4 CGPA',
      },
    ],
  };
}
