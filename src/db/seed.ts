import {
  CandidateProfile,
  MasterResume,
  NormalizedJob,
  User,
  UserPreferences,
} from '../types/index.js';
import { env } from '../config/env.js';

export const DEFAULT_USER_ID = '00000000-0000-0000-0000-000000000001';

/** Local practice board served by this server under /mock-portal. Never a real employer. */
export const DEMO_PLATFORM = 'Demo Portal';
export const DEMO_BASE_URL = `http://localhost:${env.PORT}/mock-portal`;

// Company boards verified to be live on each public ATS (users can edit these lists).
export const DEFAULT_GREENHOUSE_BOARDS = [
  'groww', 'druva', 'hackerrank', 'databricks', 'datadog', 'elastic', 'mongodb', 'okta',
  'zscaler', 'cloudflare', 'gitlab', 'stripe', 'coinbase', 'airbnb', 'samsara', 'toast',
  'twilio', 'udemy', 'coursera', 'anthropic', 'brex', 'scaleai', 'reddit', 'figma',
  'discord', 'dropbox', 'vercel', 'asana', 'pinterest', 'instacart', 'lyft', 'robinhood',
  'gusto', 'duolingo', 'squarespace', 'klaviyo', 'airtable',
];
export const DEFAULT_LEVER_COMPANIES = [
  'palantir', 'spotify', 'cred', 'zeta', 'meesho', 'paytm', 'fi', 'mindtickle',
];
export const DEFAULT_ASHBY_BOARDS = [
  'ramp', 'notion', 'openai', 'linear', 'supabase', 'posthog', 'replit', 'cursor',
  'perplexity', 'elevenlabs', 'modal', 'zapier', 'airbyte', 'sentry', 'resend', 'cohere',
  'harvey', 'writer', 'sarvam', 'plane',
];

/** Defaults for preference fields added after the first release (filled in on load). */
export const PREFERENCE_DEFAULTS: Partial<UserPreferences> = {
  search_keywords: [],
  search_locations: [],
  jobs_per_platform: 15,
  posted_within_days: 7,
  per_platform_daily_limit: 15,
  show_browser: false,
  greenhouse_boards: DEFAULT_GREENHOUSE_BOARDS,
  lever_companies: DEFAULT_LEVER_COMPANIES,
  ashby_boards: DEFAULT_ASHBY_BOARDS,
  naukri_upload_tailored_resume: true,
};

export const initialUser: User = {
  id: DEFAULT_USER_ID,
  email: 'alex.chen.eng@example.com',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

export const initialPreferences: UserPreferences = {
  id: 'pref-default-01',
  user_id: DEFAULT_USER_ID,
  minimum_match_score: 70.0,
  max_applications_per_day: 25,
  preferred_roles: [
    'Senior Full Stack Engineer',
    'Backend Developer',
    'Node.js Engineer',
    'Software Engineer',
    'Platform Engineer',
  ],
  preferred_locations: ['Remote', 'San Francisco', 'Bangalore', 'New York', 'Hybrid'],
  work_modes: ['Remote', 'Hybrid'],
  excluded_companies: ['CryptoScam LLC', 'Unethical Corp'],
  excluded_keywords: ['unpaid', 'commission only', 'gambling'],
  // Public ATS boards need no login, so automation works before any account is connected
  enabled_platforms: ['Greenhouse', 'Lever', 'Ashby'],
  automation_enabled: false,
  automation_mode: 'dry-run',
  schedule_interval_mins: 60,
  ...PREFERENCE_DEFAULTS,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

export const initialProfile: CandidateProfile = {
  id: 'profile-default-01',
  user_id: DEFAULT_USER_ID,
  full_name: 'Alex Chen',
  email: 'alex.chen.eng@example.com',
  phone: '+1 (415) 555-0192',
  location: 'San Francisco, CA (Open to Remote / Hybrid)',
  professional_summary:
    'Staff-level Full Stack & Backend Engineer with 7+ years of experience designing high-throughput distributed architectures, microservices, and AI-enabled platforms. Deep expertise in Node.js, TypeScript, PostgreSQL, Redis, React, Docker, and AWS cloud systems. Proven track record of scaling systems to 15M+ daily requests with 99.99% reliability.',
  years_of_experience: 7.5,
  notice_period_days: 15,
  salary_expectation: '$165,000 - $190,000',
  current_ctc: '$150,000',
  linkedin_url: 'https://linkedin.com/in/alexchen-eng',
  github_url: 'https://github.com/alexchen',
  portfolio_url: 'https://alexchen.dev',
  work_authorized: true,
  requires_sponsorship: false,
  willing_to_relocate: true,
  work_mode_preference: 'Remote or Hybrid',
  preferred_roles: [
    'Senior Full Stack Engineer',
    'Senior Backend Engineer',
    'Node.js Developer',
    'Lead Software Engineer',
  ],
  preferred_locations: ['Remote', 'San Francisco, CA', 'New York, NY', 'Bangalore'],
  languages: ['English (Fluent)', 'Mandarin (Conversational)'],
  certifications: [
    'AWS Certified Solutions Architect – Associate',
    'Certified Kubernetes Administrator (CKA)',
  ],
  achievements: [
    'Led migration of monolithic API to event-driven services reducing p99 latency by 68%',
    'Created open-source caching adapter with 450,000+ monthly npm downloads',
    'Recipient of 2023 Engineering Excellence Award at HyperScale Tech',
  ],
  skills: [
    { name: 'TypeScript', category: 'Technical', proficiency: 'Expert', years_experience: 6 },
    { name: 'Node.js', category: 'Technical', proficiency: 'Expert', years_experience: 7 },
    { name: 'React', category: 'Technical', proficiency: 'Advanced', years_experience: 5 },
    { name: 'PostgreSQL', category: 'Technical', proficiency: 'Expert', years_experience: 7 },
    { name: 'Redis', category: 'Technical', proficiency: 'Advanced', years_experience: 6 },
    { name: 'Express.js', category: 'Framework', proficiency: 'Expert', years_experience: 7 },
    { name: 'Docker', category: 'Tool', proficiency: 'Advanced', years_experience: 6 },
    { name: 'Kubernetes', category: 'Tool', proficiency: 'Intermediate', years_experience: 4 },
    { name: 'AWS', category: 'Technical', proficiency: 'Advanced', years_experience: 5 },
    { name: 'GraphQL', category: 'Technical', proficiency: 'Advanced', years_experience: 4 },
    { name: 'REST APIs', category: 'Technical', proficiency: 'Expert', years_experience: 7 },
    { name: 'Playwright', category: 'Tool', proficiency: 'Advanced', years_experience: 3 },
    { name: 'Python', category: 'Technical', proficiency: 'Intermediate', years_experience: 4 },
    { name: 'CI/CD Pipelines', category: 'Tool', proficiency: 'Advanced', years_experience: 5 },
    { name: 'System Design', category: 'Technical', proficiency: 'Expert', years_experience: 6 },
  ],
  experience: [
    {
      company: 'HyperScale Tech',
      role: 'Senior Software Engineer',
      location: 'San Francisco, CA (Remote)',
      start_date: '2022-03-01',
      is_current: true,
      description: 'Core backend platform engineering and high-concurrency microservices.',
      bullets: [
        'Architected an asynchronous job queue processing 12M+ background tasks daily with 99.98% success rate.',
        'Engineered distributed Redis caching tier slashing database query load by 54% during peak spikes.',
        'Mentored 6 junior and mid-level engineers in TypeScript best practices, design patterns, and automated testing.',
        'Implemented end-to-end telemetry and OpenTelemetry tracing with structured Pino logging across 18 services.',
      ],
      technologies: ['Node.js', 'TypeScript', 'PostgreSQL', 'Redis', 'Docker', 'AWS', 'Kafka'],
    },
    {
      company: 'CloudFlow Systems',
      role: 'Full Stack Engineer',
      location: 'San Francisco, CA',
      start_date: '2019-06-01',
      end_date: '2022-02-28',
      is_current: false,
      description: 'Full-stack application development for SaaS workflow orchestration.',
      bullets: [
        'Built full-stack React and Express workflow designer used by 45,000+ active enterprise users.',
        'Designed normalized PostgreSQL schemas with strict indexing and row-level partitioning for multi-tenant data.',
        'Spearheaded automated testing initiative raising unit and E2E test coverage from 42% to 91%.',
        'Streamlined Docker CI/CD pipelines reducing deployment turnaround from 35 minutes to 7 minutes.',
      ],
      technologies: ['React', 'TypeScript', 'Node.js', 'PostgreSQL', 'Docker', 'Jest'],
    },
    {
      company: 'DataWave Solutions',
      role: 'Software Engineer',
      location: 'San Jose, CA',
      start_date: '2017-08-01',
      end_date: '2019-05-31',
      is_current: false,
      description: 'Backend API design and relational data pipelines.',
      bullets: [
        'Developed robust RESTful APIs in Node.js serving mobile and web clients with sub-100ms response times.',
        'Integrated payment gateways and third-party webhook processing with idempotent database transactions.',
        'Collaborated with product designers to implement pixel-perfect user experiences and responsive layouts.',
      ],
      technologies: ['JavaScript', 'Node.js', 'PostgreSQL', 'REST APIs', 'Git'],
    },
  ],
  projects: [
    {
      title: 'DistriQueue - High-Throughput Event Broker',
      description: 'Distributed lightweight message queue built on Node.js and Redis with at-least-once delivery guarantees.',
      role: 'Lead Architect & Creator',
      url: 'https://github.com/alexchen/distriqueue',
      technologies: ['TypeScript', 'Node.js', 'Redis', 'Docker'],
      bullets: [
        'Achieved throughput of 45,000 ops/sec per single worker node with sub-5ms latency.',
        'Implemented deterministic dead-letter queue recovery and exponential backoff retry mechanisms.',
      ],
    },
    {
      title: 'AutoForm Automation Engine',
      description: 'Deterministic headless browser agent for automated enterprise workflow completion.',
      role: 'Creator',
      url: 'https://github.com/alexchen/autoform',
      technologies: ['Playwright', 'TypeScript', 'Zod', 'Node.js'],
      bullets: [
        'Engineered DOM heuristic parser mapping multi-page web forms to structured JSON schemas.',
        'Integrated automatic human verification pause triggers ensuring compliant automation.',
      ],
    },
  ],
  education: [
    {
      institution: 'University of California, Berkeley',
      degree: 'Bachelor of Science (B.S.)',
      field_of_study: 'Computer Science',
      start_year: 2013,
      end_year: 2017,
      grade: '3.82 GPA (Honors)',
    },
  ],
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

export const initialMasterResume: MasterResume = {
  id: 'resume-master-01',
  user_id: DEFAULT_USER_ID,
  title: 'Master Resume (Source of Truth)',
  is_master: true,
  content_json: {
    summary: initialProfile.professional_summary,
    skills: [
      {
        category: 'Core Technologies',
        items: ['TypeScript', 'Node.js', 'JavaScript', 'PostgreSQL', 'Redis', 'Python'],
      },
      {
        category: 'Frameworks & Frontend',
        items: ['Express.js', 'React', 'Next.js', 'Tailwind CSS', 'REST APIs', 'GraphQL'],
      },
      {
        category: 'DevOps & Tools',
        items: ['Docker', 'Kubernetes', 'AWS (ECS, S3, RDS)', 'CI/CD Pipelines', 'Playwright', 'Git'],
      },
      {
        category: 'Architecture',
        items: ['Distributed Systems', 'System Design', 'Event-Driven Architecture', 'High Concurrency'],
      },
    ],
    experience: initialProfile.experience.map((exp) => ({
      company: exp.company,
      role: exp.role,
      period: `${exp.start_date.substring(0, 7)} - ${exp.is_current ? 'Present' : exp.end_date?.substring(0, 7)}`,
      location: exp.location,
      bullets: exp.bullets,
      technologies: exp.technologies,
    })),
    projects: initialProfile.projects.map((p) => ({
      title: p.title,
      description: p.description,
      bullets: p.bullets,
      technologies: p.technologies,
      link: p.url,
    })),
    education: initialProfile.education.map((edu) => ({
      institution: edu.institution,
      degree: edu.degree,
      year: `${edu.start_year} - ${edu.end_year || 'Present'}`,
      details: `${edu.field_of_study}, ${edu.grade}`,
    })),
    certifications: initialProfile.certifications,
    achievements: initialProfile.achievements,
  },
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

export const initialJobs: NormalizedJob[] = [
  {
    id: 'job-unstop-001',
    external_id: 'unstop-dev-9182',
    platform: DEMO_PLATFORM,
    title: 'Senior Full Stack Developer (Node.js & React)',
    company: 'Nexus Innovations',
    locations: ['Remote', 'Bangalore'],
    work_mode: 'Remote',
    experience_required: '4-8 years',
    salary: '₹35,00,000 - ₹50,00,000 / year',
    description:
      'We are looking for a Senior Full Stack Engineer to lead our core products. You will build high-scale microservices with Node.js and TypeScript, interface with PostgreSQL databases, and build reactive user interfaces with React. Experience with Redis, Docker, and distributed systems is highly valued.',
    requirements: [
      'Strong proficiency in TypeScript and Node.js',
      'Solid experience with React and modern frontend build tools',
      'Hands-on expertise with PostgreSQL, schema design, and indexing',
      'Knowledge of Redis caching and asynchronous queues',
      'Familiarity with Docker and containerized deployment',
    ],
    skills: ['TypeScript', 'Node.js', 'React', 'PostgreSQL', 'Redis', 'Docker'],
    application_url: `${DEMO_BASE_URL}/job/unstop-dev-9182`,
    posted_at: new Date(Date.now() - 3600000 * 24 * 2).toISOString(),
    is_active: true,
    created_at: new Date(Date.now() - 3600000 * 24 * 2).toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: 'job-unstop-002',
    external_id: 'unstop-be-7741',
    platform: DEMO_PLATFORM,
    title: 'Senior Backend Engineer (Distributed Systems)',
    company: 'Apex Cloud Solutions',
    locations: ['Remote', 'San Francisco'],
    work_mode: 'Remote',
    experience_required: '5+ years',
    salary: '$160,000 - $185,000',
    description:
      'Join our infrastructure team to design and build high-throughput distributed systems. You will develop backend services in Node.js / TypeScript, optimize PostgreSQL query performance, manage Redis clusters, and deploy to AWS with Docker & Kubernetes.',
    requirements: [
      '5+ years building backend systems in Node.js or Go',
      'Deep understanding of PostgreSQL performance tuning and transactional integrity',
      'Experience with Redis, distributed locks, and pub/sub',
      'AWS cloud experience (ECS, RDS, S3, CloudWatch)',
      'Excellent system design and architectural instincts',
    ],
    skills: ['Node.js', 'TypeScript', 'PostgreSQL', 'Redis', 'AWS', 'Docker', 'System Design'],
    application_url: `${DEMO_BASE_URL}/job/unstop-be-7741`,
    posted_at: new Date(Date.now() - 3600000 * 24 * 1).toISOString(),
    is_active: true,
    created_at: new Date(Date.now() - 3600000 * 24 * 1).toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: 'job-unstop-003',
    external_id: 'unstop-sec-3312',
    platform: DEMO_PLATFORM,
    title: 'Staff Platform & Automation Engineer',
    company: 'SecureScale AI',
    locations: ['Hybrid', 'Bangalore'],
    work_mode: 'Hybrid',
    experience_required: '6+ years',
    salary: '₹45,00,000 - ₹60,00,000 / year',
    description:
      'SecureScale AI is seeking a Staff Platform Engineer to engineer automation pipelines, microservices, and reliable cloud workflows. You will lead automation initiatives using Playwright and Node.js, scale relational databases, and collaborate across teams.',
    requirements: [
      '6+ years of software engineering experience',
      'Strong expertise in Node.js, TypeScript, and Playwright browser automation',
      'PostgreSQL, Redis, and message broker experience',
      'Experience building fault-tolerant workers with exponential backoff and error recovery',
    ],
    skills: ['TypeScript', 'Node.js', 'Playwright', 'PostgreSQL', 'Redis', 'CI/CD Pipelines'],
    application_url: `${DEMO_BASE_URL}/job/unstop-sec-3312`,
    posted_at: new Date(Date.now() - 3600000 * 12).toISOString(),
    is_active: true,
    created_at: new Date(Date.now() - 3600000 * 12).toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: 'job-unstop-004',
    external_id: 'unstop-ml-5509',
    platform: DEMO_PLATFORM,
    title: 'Lead AI Application Engineer',
    company: 'Cognitive Engine Corp',
    locations: ['Remote'],
    work_mode: 'Remote',
    experience_required: '5-9 years',
    salary: '$150,000 - $180,000',
    description:
      'Build generative AI integrations, structured JSON extraction pipelines, and high-performance APIs. Must have strong TypeScript, Node.js, and LLM orchestration experience, with zero-tolerance for ungrounded hallucination.',
    requirements: [
      'Experience integrating LLM APIs (Gemini, Claude, or OpenAI) with strict schema validation (Zod)',
      'High-throughput backend engineering in Node.js / TypeScript',
      'PostgreSQL database design and vector search familiarity',
    ],
    skills: ['TypeScript', 'Node.js', 'PostgreSQL', 'REST APIs', 'System Design'],
    application_url: `${DEMO_BASE_URL}/job/unstop-ml-5509`,
    posted_at: new Date(Date.now() - 3600000 * 6).toISOString(),
    is_active: true,
    created_at: new Date(Date.now() - 3600000 * 6).toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: 'job-unstop-005',
    external_id: 'unstop-captcha-demo',
    platform: DEMO_PLATFORM,
    title: 'Principal Systems Architect (Security Verification Demo)',
    company: 'CyberGate Defense',
    locations: ['Onsite', 'San Francisco'],
    work_mode: 'Onsite',
    experience_required: '8+ years',
    salary: '$180,000 - $210,000',
    description:
      'High security application testing endpoint designed to verify human verification detection and workflow pausing compliance.',
    requirements: ['Experience with enterprise security, MFA, and automated compliance'],
    skills: ['System Design', 'TypeScript', 'AWS'],
    application_url: `${DEMO_BASE_URL}/job/unstop-captcha-demo`,
    posted_at: new Date(Date.now() - 3600000 * 3).toISOString(),
    is_active: true,
    created_at: new Date(Date.now() - 3600000 * 3).toISOString(),
    updated_at: new Date().toISOString(),
  },
];
