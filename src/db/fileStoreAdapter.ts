import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import {
  User,
  UserPreferences,
  CandidateProfile,
  MasterResume,
  ResumeVersion,
  NormalizedJob,
  JobMatch,
  Application,
  ApplicationQuestion,
  ApplicationAnswer,
  AutomationRun,
  AutomationStep,
  AutomationError,
  AIRequestLog,
  MasterResumeContent,
  PlatformCredential,
  AnswerBankEntry,
  JobBookmark,
} from '../types/index.js';
import {
  IRepository,
  JobFilterOptions,
  ApplicationFilterOptions,
  DashboardStats,
  AnalyticsData,
  TRANSIENT_APPLICATION_STATUSES,
} from './repository.js';
import {
  DEFAULT_USER_ID,
  DEMO_PLATFORM,
  PREFERENCE_DEFAULTS,
  initialUser,
  initialPreferences,
  initialProfile,
  initialMasterResume,
  initialJobs,
} from './seed.js';
import { VERIFIED_LIVE_DRIVES_AND_JOBS, liveJobSearchService } from '../automation/liveSearch/liveSearchService.js';
import { env } from '../config/env.js';
import { paths } from '../config/paths.js';
import { logger } from '../config/logger.js';

interface DatabaseSchema {
  users: User[];
  preferences: UserPreferences[];
  profiles: CandidateProfile[];
  resumes: MasterResume[];
  resume_versions: ResumeVersion[];
  jobs: NormalizedJob[];
  matches: JobMatch[];
  applications: Application[];
  questions: ApplicationQuestion[];
  answers: ApplicationAnswer[];
  runs: AutomationRun[];
  steps: AutomationStep[];
  errors: AutomationError[];
  ai_logs: AIRequestLog[];
  ai_cache: Record<string, any>;
  credentials: PlatformCredential[];
  answer_bank: AnswerBankEntry[];
  bookmarks: JobBookmark[];
}

// Keep the JSON file bounded: logs older than this are trimmed on write
const MAX_STEPS = 5000;
const MAX_AI_LOGS = 2000;

export class FileStoreAdapter implements IRepository {
  private filePath: string;
  private data: DatabaseSchema;
  private initialized: boolean = false;
  private initPromise: Promise<void> | null = null;
  private writeLock: Promise<void> = Promise.resolve();

  constructor(filePath?: string) {
    this.filePath = filePath || paths.dbFile;
    this.data = this.getDefaultData();
  }

  private getDefaultData(): DatabaseSchema {
    return {
      users: [{ ...initialUser }],
      preferences: [{ ...initialPreferences }],
      profiles: [{ ...initialProfile }],
      resumes: [{ ...initialMasterResume }],
      resume_versions: [],
      jobs: env.SEED_DEMO_DATA ? initialJobs.map((j) => ({ ...j })) : [],
      matches: [],
      applications: [],
      questions: [],
      answers: [],
      runs: [],
      steps: [],
      errors: [],
      ai_logs: [],
      ai_cache: {},
      credentials: [],
      answer_bank: [],
      bookmarks: [],
    };
  }

  public async init(): Promise<void> {
    if (this.initialized) return;
    if (!this.initPromise) {
      this.initPromise = this.load();
    }
    await this.initPromise;
  }

  private async load(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const raw = await fs.readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      const defaults = this.getDefaultData();
      this.data = { ...defaults, ...parsed };
      // Collections added in later versions may be missing from older files
      for (const key of Object.keys(defaults) as (keyof DatabaseSchema)[]) {
        if (this.data[key] === undefined || this.data[key] === null) {
          (this.data as any)[key] = defaults[key];
        }
      }
      if (this.migrateLegacyData()) {
        await this.persist();
      }
      logger.info({ path: this.filePath }, 'FileStore database loaded successfully');
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        logger.info({ path: this.filePath }, 'Initializing new FileStore database');
      } else {
        // Never silently overwrite an unreadable database: keep a copy for recovery
        const backup = `${this.filePath}.corrupt-${Date.now()}`;
        await fs.copyFile(this.filePath, backup).catch(() => {});
        logger.error({ err: err.message, backup }, 'Failed reading FileStore database; started fresh and kept a backup');
      }
      this.data = this.getDefaultData();
      await this.persist();
    }

    this.initialized = true;
  }

  /** Brings records written by older versions up to the current shape. Returns true if anything changed. */
  private migrateLegacyData(): boolean {
    let changed = false;

    if (!this.data.bookmarks) {
      this.data.bookmarks = [];
      changed = true;
    }

    // Earlier releases labelled the local mock-portal jobs as "Unstop", which made
    // them look like real applications. They belong to the demo board.
    for (const job of this.data.jobs) {
      if (job.application_url?.includes('/mock-portal/') && job.platform !== DEMO_PLATFORM) {
        job.platform = DEMO_PLATFORM;
        changed = true;
      }
      if (!job.verification_status) {
        job.verification_status = job.is_active !== false ? 'verified_live' : 'closed';
        job.last_verified_at = job.last_verified_at || job.updated_at || this.now();
        changed = true;
      }
      if (!job.sources || job.sources.length === 0) {
        job.sources = [{ platform: job.platform, url: job.application_url, is_verified: job.verification_status === 'verified_live' }];
        changed = true;
      }
    }

    // Seed verified live drives & off-campus opportunities if missing
    for (const drive of VERIFIED_LIVE_DRIVES_AND_JOBS) {
      const exists = this.data.jobs.some(
        (j) => j.external_id === drive.external_id || (j.company === drive.company && j.title === drive.title)
      );
      if (!exists && drive.title && drive.company && drive.application_url) {
        const fullJob: NormalizedJob = {
          id: uuidv4(),
          external_id: drive.external_id || `live-${Date.now()}`,
          platform: drive.platform || 'BulkDrives',
          title: drive.title,
          company: drive.company,
          company_logo: drive.company_logo,
          locations: drive.locations || ['Delhi NCR', 'Noida', 'Gurugram', 'Remote'],
          work_mode: drive.work_mode || 'Hybrid',
          experience_required: drive.experience_required || 'Fresher (0 - 1 Yr)',
          min_experience_years: drive.min_experience_years ?? 0,
          max_experience_years: drive.max_experience_years ?? 1,
          salary: drive.salary || 'Competitive',
          min_salary: drive.min_salary,
          max_salary: drive.max_salary,
          salary_currency: drive.salary_currency || 'INR',
          job_type: drive.job_type || 'full_time',
          recruitment_type: drive.recruitment_type || 'bulk_hiring',
          is_bulk_hiring: drive.is_bulk_hiring ?? true,
          walk_in_details: drive.walk_in_details,
          education_required: drive.education_required || ['BCA', 'B.Tech', 'MCA'],
          description: drive.description || '',
          requirements: drive.requirements || [],
          skills: drive.skills || [],
          application_url: drive.application_url,
          application_deadline: drive.application_deadline,
          posted_at: drive.posted_at || this.now(),
          is_active: true,
          verification_status: drive.verification_status || 'verified_live',
          last_verified_at: drive.last_verified_at || this.now(),
          verification_details: drive.verification_details,
          sources: drive.sources || [{ platform: drive.platform || 'BulkDrives', url: drive.application_url, is_verified: true }],
          apply_mode: drive.apply_mode || 'direct_automated',
          industry: drive.industry,
          company_size: drive.company_size,
          created_at: this.now(),
          updated_at: this.now(),
        };
        this.data.jobs.unshift(fullJob);
        changed = true;
      }
    }

    for (const pref of this.data.preferences) {
      for (const [key, value] of Object.entries(PREFERENCE_DEFAULTS)) {
        if ((pref as any)[key] === undefined) {
          (pref as any)[key] = Array.isArray(value) ? [...value] : value;
          changed = true;
        }
      }
    }

    for (const app of this.data.applications) {
      if (!app.platform) {
        const job = this.data.jobs.find((j) => j.id === app.job_id);
        if (job) {
          app.platform = job.platform;
          changed = true;
        }
      }
    }

    return changed;
  }

  private async persist(): Promise<void> {
    if (this.data.steps.length > MAX_STEPS) this.data.steps.length = MAX_STEPS;
    if (this.data.ai_logs.length > MAX_AI_LOGS) this.data.ai_logs.length = MAX_AI_LOGS;

    // Chain writes to prevent concurrent write corruption
    this.writeLock = this.writeLock.then(async () => {
      try {
        const tempPath = `${this.filePath}.tmp`;
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        await fs.writeFile(tempPath, JSON.stringify(this.data, null, 2), 'utf-8');
        await fs.rename(tempPath, this.filePath);
      } catch (err) {
        logger.error({ err }, 'Failed writing FileStore database to disk');
      }
    });
    await this.writeLock;
  }

  private now(): string {
    return new Date().toISOString();
  }

  // --- Users & Preferences ---
  async getUser(userId: string): Promise<User | null> {
    await this.init();
    return this.data.users.find((u) => u.id === userId) || null;
  }

  async getUsers(): Promise<User[]> {
    await this.init();
    return this.data.users;
  }

  async createUser(email: string, fullName?: string): Promise<{ user: User; profile: CandidateProfile }> {
    await this.init();
    const existing = this.data.users.find((u) => u.email.toLowerCase() === email.toLowerCase());
    if (existing) {
      const profile = await this.getProfile(existing.id);
      return { user: existing, profile };
    }

    const newUser: User = {
      id: uuidv4(),
      email,
      created_at: this.now(),
      updated_at: this.now(),
    };
    this.data.users.push(newUser);

    const newProfile = this.blankProfile(newUser.id, email, fullName);
    this.data.profiles.push(newProfile);

    this.data.preferences.push(this.defaultPreferences(newUser.id));
    this.data.resumes.push(this.blankMasterResume(newUser.id));

    await this.persist();
    return { user: newUser, profile: newProfile };
  }

  private blankProfile(userId: string, email = '', fullName?: string): CandidateProfile {
    return {
      id: uuidv4(),
      user_id: userId,
      full_name: fullName || (email ? email.split('@')[0] : ''),
      email,
      phone: '',
      location: '',
      professional_summary: '',
      years_of_experience: 0,
      notice_period_days: 30,
      salary_expectation: '',
      work_mode_preference: 'Remote or Hybrid',
      preferred_roles: [],
      preferred_locations: [],
      languages: ['English'],
      certifications: [],
      achievements: [],
      skills: [],
      experience: [],
      projects: [],
      education: [],
      work_authorized: true,
      requires_sponsorship: false,
      willing_to_relocate: false,
      created_at: this.now(),
      updated_at: this.now(),
    };
  }

  private blankMasterResume(userId: string): MasterResume {
    return {
      id: uuidv4(),
      user_id: userId,
      title: 'Master Resume',
      is_master: true,
      content_json: {
        summary: '',
        skills: [],
        experience: [],
        projects: [],
        education: [],
        certifications: [],
        achievements: [],
      },
      created_at: this.now(),
      updated_at: this.now(),
    };
  }

  private defaultPreferences(userId: string): UserPreferences {
    return {
      ...initialPreferences,
      ...PREFERENCE_DEFAULTS,
      preferred_roles: [],
      preferred_locations: [],
      work_modes: ['Remote', 'Hybrid', 'Onsite'],
      excluded_companies: [],
      enabled_platforms: [...(initialPreferences.enabled_platforms || [])],
      id: uuidv4(),
      user_id: userId,
      created_at: this.now(),
      updated_at: this.now(),
    };
  }

  async getPreferences(userId: string): Promise<UserPreferences> {
    await this.init();
    let pref = this.data.preferences.find((p) => p.user_id === userId);
    if (!pref) {
      pref = userId === DEFAULT_USER_ID ? { ...initialPreferences } : this.defaultPreferences(userId);
      this.data.preferences.push(pref);
      await this.persist();
    }
    return pref;
  }

  async getAllPreferences(): Promise<UserPreferences[]> {
    await this.init();
    return [...this.data.preferences];
  }

  async updatePreferences(userId: string, prefs: Partial<UserPreferences>): Promise<UserPreferences> {
    await this.init();
    const { id: _id, user_id: _uid, created_at: _c, ...safe } = prefs as UserPreferences;
    const idx = this.data.preferences.findIndex((p) => p.user_id === userId);
    if (idx >= 0) {
      this.data.preferences[idx] = {
        ...this.data.preferences[idx],
        ...safe,
        updated_at: this.now(),
      };
      await this.persist();
      return this.data.preferences[idx];
    }
    const newPref: UserPreferences = {
      ...this.defaultPreferences(userId),
      ...safe,
    };
    this.data.preferences.push(newPref);
    await this.persist();
    return newPref;
  }

  // --- Candidate Profile ---
  async getProfile(userId: string): Promise<CandidateProfile> {
    await this.init();
    let profile = this.data.profiles.find((p) => p.user_id === userId);
    if (!profile) {
      profile = userId === DEFAULT_USER_ID ? { ...initialProfile } : this.blankProfile(userId);
      this.data.profiles.push(profile);
      await this.persist();
    }
    return profile;
  }

  async updateProfile(userId: string, updates: Partial<CandidateProfile>): Promise<CandidateProfile> {
    await this.init();
    const { id: _id, user_id: _uid, created_at: _c, ...safe } = updates as CandidateProfile;
    const idx = this.data.profiles.findIndex((p) => p.user_id === userId);
    if (idx >= 0) {
      this.data.profiles[idx] = {
        ...this.data.profiles[idx],
        ...safe,
        updated_at: this.now(),
      };
      await this.persist();
      return this.data.profiles[idx];
    }
    const newProf: CandidateProfile = {
      ...this.blankProfile(userId),
      ...safe,
    };
    this.data.profiles.push(newProf);
    await this.persist();
    return newProf;
  }

  // --- Resumes ---
  async getMasterResume(userId: string): Promise<MasterResume> {
    await this.init();
    let resume = this.data.resumes.find((r) => r.user_id === userId && r.is_master);
    if (!resume) {
      resume = userId === DEFAULT_USER_ID ? { ...initialMasterResume } : this.blankMasterResume(userId);
      this.data.resumes.push(resume);
      await this.persist();
    }
    return resume;
  }

  async updateMasterResume(userId: string, content: MasterResumeContent): Promise<MasterResume> {
    await this.init();
    const idx = this.data.resumes.findIndex((r) => r.user_id === userId && r.is_master);
    if (idx >= 0) {
      this.data.resumes[idx] = {
        ...this.data.resumes[idx],
        content_json: content,
        updated_at: this.now(),
      };
      await this.persist();
      return this.data.resumes[idx];
    }
    const newResume: MasterResume = { ...this.blankMasterResume(userId), content_json: content };
    this.data.resumes.push(newResume);
    await this.persist();
    return newResume;
  }

  async getResumeVersions(userId: string, jobId?: string): Promise<ResumeVersion[]> {
    await this.init();
    return this.data.resume_versions
      .filter((rv) => rv.user_id === userId && (!jobId || rv.job_id === jobId))
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }

  async getResumeVersion(id: string): Promise<ResumeVersion | null> {
    await this.init();
    return this.data.resume_versions.find((rv) => rv.id === id) || null;
  }

  async createResumeVersion(
    version: Omit<ResumeVersion, 'id' | 'created_at' | 'updated_at'>
  ): Promise<ResumeVersion> {
    await this.init();
    const newVersion: ResumeVersion = {
      ...version,
      id: uuidv4(),
      created_at: this.now(),
      updated_at: this.now(),
    };
    this.data.resume_versions.push(newVersion);
    await this.persist();
    return newVersion;
  }

  async deleteResumeVersion(id: string): Promise<boolean> {
    await this.init();
    const prevLen = this.data.resume_versions.length;
    this.data.resume_versions = this.data.resume_versions.filter((rv) => rv.id !== id);
    if (this.data.resume_versions.length !== prevLen) {
      await this.persist();
      return true;
    }
    return false;
  }

  // --- Jobs ---
  async getJobs(options?: JobFilterOptions): Promise<{ jobs: NormalizedJob[]; total: number }> {
    await this.init();
    let list = [...this.data.jobs];

    // 1. Keyword search (title, company, description, skills, education)
    if (options?.keyword) {
      const kw = options.keyword.toLowerCase().trim();
      list = list.filter(
        (j) =>
          j.title.toLowerCase().includes(kw) ||
          j.company.toLowerCase().includes(kw) ||
          j.description.toLowerCase().includes(kw) ||
          j.skills.some((s) => s.toLowerCase().includes(kw)) ||
          (j.education_required && j.education_required.some((e) => e.toLowerCase().includes(kw))) ||
          j.locations.some((l) => l.toLowerCase().includes(kw))
      );
    }

    // 2. Excluded keywords
    if (options?.excluded_keywords && options.excluded_keywords.length > 0) {
      const exKws = options.excluded_keywords.map((k) => k.toLowerCase().trim()).filter(Boolean);
      list = list.filter(
        (j) =>
          !exKws.some(
            (k) =>
              j.title.toLowerCase().includes(k) ||
              j.company.toLowerCase().includes(k) ||
              j.description.toLowerCase().includes(k) ||
              j.skills.some((s) => s.toLowerCase().includes(k))
          )
      );
    }

    // 3. Location filtering (single string or array of locations)
    const locQueries = (options?.locations && options.locations.length > 0
      ? options.locations
      : options?.location
      ? [options.location]
      : []
    ).map((l) => l.toLowerCase().trim()).filter(Boolean);

    if (locQueries.length > 0) {
      list = list.filter((j) => {
        const jobLocs = j.locations.map((l) => l.toLowerCase());
        const jobWorkMode = (j.work_mode || '').toLowerCase();

        return locQueries.some((q) => {
          if (q === 'remote') return jobWorkMode.includes('remote') || jobLocs.some((l) => l.includes('remote'));
          if (q === 'hybrid') return jobWorkMode.includes('hybrid') || jobLocs.some((l) => l.includes('hybrid'));
          if (q === 'onsite' || q === 'on-site') return jobWorkMode.includes('onsite') || jobWorkMode.includes('on-site');

          // Delhi NCR grouping
          if (q.includes('delhi') || q.includes('ncr')) {
            return jobLocs.some(
              (l) =>
                l.includes('delhi') ||
                l.includes('ncr') ||
                l.includes('noida') ||
                l.includes('gurugram') ||
                l.includes('gurgaon') ||
                l.includes('faridabad') ||
                l.includes('ghaziabad')
            );
          }

          return jobLocs.some((l) => l.includes(q)) || jobWorkMode.includes(q);
        });
      });
    }

    // 4. Work Mode
    const workModes = (options?.work_modes && options.work_modes.length > 0
      ? options.work_modes
      : options?.work_mode
      ? [options.work_mode]
      : []
    ).map((m) => m.toLowerCase().trim());

    if (workModes.length > 0) {
      list = list.filter((j) => {
        const mode = (j.work_mode || '').toLowerCase();
        return workModes.some((m) => mode.includes(m));
      });
    }

    // 5. Experience Level / Freshers
    if (options?.only_freshers || options?.experience_level === 'fresher') {
      list = list.filter((j) => {
        if (j.min_experience_years !== undefined && j.min_experience_years === 0) return true;
        const text = `${j.experience_required} ${j.title} ${j.description}`.toLowerCase();
        return (
          text.includes('fresher') ||
          text.includes('entry level') ||
          text.includes('0 - 1') ||
          text.includes('0-1') ||
          text.includes('0 to 1') ||
          text.includes('0 yr') ||
          text.includes('trainee') ||
          text.includes('graduate')
        );
      });
    } else if (options?.experience_level && options.experience_level !== 'all') {
      const expLevel = options.experience_level;
      list = list.filter((j) => {
        const min = j.min_experience_years ?? 0;
        const max = j.max_experience_years ?? min;
        if (expLevel === '0-1') return min <= 1;
        if (expLevel === '1-2') return min <= 2 && max >= 1;
        if (expLevel === '2-3') return min <= 3 && max >= 2;
        if (expLevel === '3-5') return min <= 5 && max >= 3;
        if (expLevel === '5+') return max >= 5;
        return true;
      });
    } else {
      if (options?.min_experience !== undefined) {
        list = list.filter((j) => (j.min_experience_years ?? 0) >= options.min_experience!);
      }
      if (options?.max_experience !== undefined) {
        list = list.filter((j) => (j.min_experience_years ?? 0) <= options.max_experience!);
      }
    }

    // 6. Salary filters (numeric comparison)
    if (options?.min_salary !== undefined && options.min_salary > 0) {
      list = list.filter((j) => {
        if (j.max_salary && j.max_salary >= options.min_salary!) return true;
        if (j.min_salary && j.min_salary >= options.min_salary!) return true;
        return !j.min_salary && !j.max_salary; // Keep undisclosed salaries
      });
    }
    if (options?.max_salary !== undefined && options.max_salary > 0) {
      list = list.filter((j) => {
        if (j.min_salary && j.min_salary <= options.max_salary!) return true;
        return true;
      });
    }

    // 7. Job Type (full_time, internship, trainee, etc.)
    if (options?.job_types && options.job_types.length > 0) {
      const types = options.job_types.map((t) => t.toLowerCase());
      list = list.filter((j) => {
        const jt = (j.job_type || 'full_time').toLowerCase();
        return types.some((t) => jt.includes(t));
      });
    }

    // 8. Roles
    if (options?.roles && options.roles.length > 0) {
      const roleQueries = options.roles.map((r) => r.toLowerCase().trim());
      list = list.filter((j) => {
        const title = j.title.toLowerCase();
        return roleQueries.some((r) => title.includes(r));
      });
    }

    // 9. Technologies / Skills
    if (options?.technologies && options.technologies.length > 0) {
      const techs = options.technologies.map((t) => t.toLowerCase().trim());
      list = list.filter((j) => {
        const jobSkills = j.skills.map((s) => s.toLowerCase());
        const desc = j.description.toLowerCase();
        return techs.some((t) => jobSkills.some((s) => s.includes(t)) || desc.includes(t));
      });
    }

    // 10. Education / Qualifications (BCA, B.Tech, MCA, etc.)
    if (options?.education && options.education.length > 0) {
      const eduList = options.education.map((e) => e.toLowerCase().trim());
      list = list.filter((j) => {
        const jobEdus = (j.education_required || []).map((e) => e.toLowerCase());
        const desc = j.description.toLowerCase();
        return eduList.some((e) => jobEdus.some((je) => je.includes(e)) || desc.includes(e) || desc.includes('any graduate'));
      });
    }

    // 11. Company Name
    if (options?.company_name) {
      const c = options.company_name.toLowerCase().trim();
      list = list.filter((j) => j.company.toLowerCase().includes(c));
    }

    // 12. Recruitment Type / Bulk Hiring
    if (options?.only_bulk_hiring) {
      list = list.filter(
        (j) =>
          Boolean(j.is_bulk_hiring) ||
          (Boolean(j.recruitment_type) && j.recruitment_type !== 'regular') ||
          Boolean(j.walk_in_details)
      );
    } else if (options?.recruitment_types && options.recruitment_types.length > 0) {
      const rTypes = options.recruitment_types.map((t) => t.toLowerCase());
      list = list.filter((j) => {
        const rt = (j.recruitment_type || 'regular').toLowerCase();
        return rTypes.includes(rt);
      });
    }

    // 13. Posting Date Freshness
    if (options?.posted_within_days) {
      const cutoff = Date.now() - options.posted_within_days * 86400000;
      list = list.filter((j) => {
        const dateStr = j.posted_at || j.created_at;
        return new Date(dateStr).getTime() >= cutoff;
      });
    }

    // 14. Platforms
    const platforms = (options?.platforms && options.platforms.length > 0
      ? options.platforms
      : options?.platform
      ? [options.platform]
      : []
    ).map((p) => p.toLowerCase().trim());

    if (platforms.length > 0) {
      list = list.filter((j) => {
        const p = j.platform.toLowerCase();
        const sources = (j.sources || []).map((s) => s.platform.toLowerCase());
        return platforms.some((queryP) => p.includes(queryP) || sources.some((s) => s.includes(queryP)));
      });
    }

    // 15. Verification Status
    if (options?.verification_status && options.verification_status !== 'all') {
      if (options.verification_status === 'verified_live') {
        list = list.filter((j) => j.verification_status === 'verified_live' && j.is_active !== false);
      } else if (options.verification_status === 'unverified') {
        list = list.filter((j) => j.verification_status === 'unverified' || j.verification_status === 'checking');
      }
    }

    // 16. Deduplicate & consolidate multi-source postings
    list = liveJobSearchService.deduplicateJobs(list);

    // 17. Sorting
    const sortBy = options?.sort_by || 'newest';
    if (sortBy === 'newest') {
      list.sort((a, b) => new Date(b.posted_at || b.created_at).getTime() - new Date(a.posted_at || a.created_at).getTime());
    } else if (sortBy === 'salary_high') {
      list.sort((a, b) => (b.max_salary || b.min_salary || 0) - (a.max_salary || a.min_salary || 0));
    } else if (sortBy === 'experience_low') {
      list.sort((a, b) => (a.min_experience_years ?? 0) - (b.min_experience_years ?? 0));
    } else if (sortBy === 'deadline') {
      list.sort((a, b) => {
        if (!a.application_deadline) return 1;
        if (!b.application_deadline) return -1;
        return new Date(a.application_deadline).getTime() - new Date(b.application_deadline).getTime();
      });
    }

    const total = list.length;
    const offset = options?.offset || 0;
    const limit = options?.limit ?? 50;

    return {
      jobs: list.slice(offset, offset + limit),
      total,
    };
  }

  async updateJob(id: string, updates: Partial<NormalizedJob>): Promise<NormalizedJob | null> {
    await this.init();
    const idx = this.data.jobs.findIndex((j) => j.id === id);
    if (idx < 0) return null;
    this.data.jobs[idx] = {
      ...this.data.jobs[idx],
      ...updates,
      updated_at: this.now(),
    };
    await this.persist();
    return this.data.jobs[idx];
  }

  async bookmarkJob(userId: string, jobId: string, notes?: string): Promise<boolean> {
    await this.init();
    if (!this.data.bookmarks) this.data.bookmarks = [];
    const existing = this.data.bookmarks.find((b) => b.user_id === userId && b.job_id === jobId);
    if (existing) {
      if (notes !== undefined) existing.notes = notes;
      await this.persist();
      return true;
    }
    this.data.bookmarks.push({
      id: uuidv4(),
      user_id: userId,
      job_id: jobId,
      notes,
      created_at: this.now(),
    });
    await this.persist();
    return true;
  }

  async unbookmarkJob(userId: string, jobId: string): Promise<boolean> {
    await this.init();
    if (!this.data.bookmarks) this.data.bookmarks = [];
    const prev = this.data.bookmarks.length;
    this.data.bookmarks = this.data.bookmarks.filter((b) => !(b.user_id === userId && b.job_id === jobId));
    if (this.data.bookmarks.length !== prev) {
      await this.persist();
      return true;
    }
    return false;
  }

  async getBookmarks(userId: string): Promise<string[]> {
    await this.init();
    if (!this.data.bookmarks) return [];
    return this.data.bookmarks.filter((b) => b.user_id === userId).map((b) => b.job_id);
  }

  async getJob(id: string): Promise<NormalizedJob | null> {
    await this.init();
    return this.data.jobs.find((j) => j.id === id) || null;
  }

  async getJobByExternalId(platform: string, externalId: string): Promise<NormalizedJob | null> {
    await this.init();
    return (
      this.data.jobs.find((j) => j.platform === platform && j.external_id === externalId) || null
    );
  }

  async upsertJob(
    job: Omit<NormalizedJob, 'id' | 'created_at' | 'updated_at'> & { id?: string }
  ): Promise<NormalizedJob> {
    await this.init();
    const existingIdx = this.data.jobs.findIndex(
      (j) => j.platform === job.platform && j.external_id === job.external_id
    );

    if (existingIdx >= 0) {
      const existing = this.data.jobs[existingIdx];
      this.data.jobs[existingIdx] = {
        ...existing,
        ...job,
        // A shallow re-discovery must not wipe a description fetched earlier
        description:
          job.description && job.description.length >= (existing.description?.length || 0) * 0.5
            ? job.description
            : existing.description,
        id: existing.id,
        updated_at: this.now(),
      };
      await this.persist();
      return this.data.jobs[existingIdx];
    }
    const newJob: NormalizedJob = {
      ...job,
      id: job.id || uuidv4(),
      created_at: this.now(),
      updated_at: this.now(),
    };
    this.data.jobs.unshift(newJob);
    await this.persist();
    return newJob;
  }

  // --- Job Matches ---
  async getMatch(userId: string, jobId: string): Promise<JobMatch | null> {
    await this.init();
    return this.data.matches.find((m) => m.user_id === userId && m.job_id === jobId) || null;
  }

  async getMatches(userId: string): Promise<JobMatch[]> {
    await this.init();
    return this.data.matches.filter((m) => m.user_id === userId);
  }

  async saveMatch(match: Omit<JobMatch, 'id' | 'created_at'>): Promise<JobMatch> {
    await this.init();
    const idx = this.data.matches.findIndex(
      (m) => m.user_id === match.user_id && m.job_id === match.job_id
    );
    if (idx >= 0) {
      this.data.matches[idx] = {
        ...this.data.matches[idx],
        ...match,
      };
      await this.persist();
      return this.data.matches[idx];
    }
    const newMatch: JobMatch = {
      ...match,
      id: uuidv4(),
      created_at: this.now(),
    };
    this.data.matches.push(newMatch);
    await this.persist();
    return newMatch;
  }

  // --- Applications ---
  async getApplications(
    userId: string,
    options?: ApplicationFilterOptions
  ): Promise<{ applications: Application[]; total: number }> {
    await this.init();
    let list = this.data.applications.filter((a) => a.user_id === userId);

    if (options?.status) {
      list = list.filter((a) => a.status === options.status);
    }

    list.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    const total = list.length;
    const offset = options?.offset || 0;
    const limit = options?.limit ?? 50;

    return {
      applications: list.slice(offset, offset + limit).map((app) => this.hydrateApplication(app)),
      total,
    };
  }

  private hydrateApplication(app: Application): Application {
    const job = this.data.jobs.find((j) => j.id === app.job_id);
    const resume = app.resume_version_id
      ? this.data.resume_versions.find((rv) => rv.id === app.resume_version_id)
      : undefined;
    const match = this.data.matches.find(
      (m) => m.user_id === app.user_id && m.job_id === app.job_id
    );
    const questions = this.data.questions
      .filter((q) => q.application_id === app.id)
      .map((q) => {
        const answer = this.data.answers.find((ans) => ans.question_id === q.id);
        return { ...q, answer };
      });

    return {
      ...app,
      job,
      resume_version: resume,
      match,
      questions,
    };
  }

  async getApplication(id: string): Promise<Application | null> {
    await this.init();
    const app = this.data.applications.find((a) => a.id === id);
    if (!app) return null;
    return this.hydrateApplication(app);
  }

  async getApplicationByJob(userId: string, jobId: string): Promise<Application | null> {
    await this.init();
    const app = this.data.applications.find((a) => a.user_id === userId && a.job_id === jobId);
    if (!app) return null;
    return this.hydrateApplication(app);
  }

  async createApplication(
    app: Omit<Application, 'id' | 'created_at' | 'updated_at'>
  ): Promise<Application> {
    await this.init();
    const newApp: Application = {
      ...app,
      id: uuidv4(),
      created_at: this.now(),
      updated_at: this.now(),
    };
    this.data.applications.unshift(newApp);
    await this.persist();
    return this.hydrateApplication(newApp);
  }

  async updateApplication(id: string, updates: Partial<Application>): Promise<Application> {
    await this.init();
    const idx = this.data.applications.findIndex((a) => a.id === id);
    if (idx < 0) {
      throw new Error(`Application with id ${id} not found`);
    }

    // Joined relations are computed on read and must never be stored
    const { job: _j, resume_version: _r, match: _m, questions: _q, ...safe } = updates;

    this.data.applications[idx] = {
      ...this.data.applications[idx],
      ...safe,
      updated_at: this.now(),
    };
    await this.persist();
    return this.hydrateApplication(this.data.applications[idx]);
  }

  // --- Questions & Answers ---
  async getQuestions(
    applicationId: string
  ): Promise<(ApplicationQuestion & { answer?: ApplicationAnswer })[]> {
    await this.init();
    return this.data.questions
      .filter((q) => q.application_id === applicationId)
      .map((q) => ({
        ...q,
        answer: this.data.answers.find((a) => a.question_id === q.id),
      }));
  }

  async saveQuestion(
    question: Omit<ApplicationQuestion, 'id' | 'created_at'>
  ): Promise<ApplicationQuestion> {
    await this.init();
    const newQ: ApplicationQuestion = {
      ...question,
      id: uuidv4(),
      created_at: this.now(),
    };
    this.data.questions.push(newQ);
    await this.persist();
    return newQ;
  }

  async saveAnswer(answer: Omit<ApplicationAnswer, 'id' | 'created_at'>): Promise<ApplicationAnswer> {
    await this.init();
    const newA: ApplicationAnswer = {
      ...answer,
      id: uuidv4(),
      created_at: this.now(),
    };
    this.data.answers.push(newA);
    await this.persist();
    return newA;
  }

  // --- Automation Runs, Steps, Errors ---
  async createRun(run: Omit<AutomationRun, 'id' | 'started_at'>): Promise<AutomationRun> {
    await this.init();
    const newRun: AutomationRun = {
      ...run,
      id: uuidv4(),
      started_at: this.now(),
    };
    this.data.runs.unshift(newRun);
    await this.persist();
    return newRun;
  }

  async updateRun(id: string, updates: Partial<AutomationRun>): Promise<AutomationRun> {
    await this.init();
    const idx = this.data.runs.findIndex((r) => r.id === id);
    if (idx < 0) throw new Error(`Run ${id} not found`);
    this.data.runs[idx] = { ...this.data.runs[idx], ...updates };
    await this.persist();
    return this.data.runs[idx];
  }

  async getRuns(userId: string, limit: number = 20): Promise<AutomationRun[]> {
    await this.init();
    return this.data.runs
      .filter((r) => r.user_id === userId)
      .sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime())
      .slice(0, limit);
  }

  async getActiveRun(userId: string): Promise<AutomationRun | null> {
    await this.init();
    return (
      this.data.runs.find((r) => r.user_id === userId && r.status === 'running') || null
    );
  }

  async addStep(step: Omit<AutomationStep, 'id' | 'created_at'>): Promise<AutomationStep> {
    await this.init();
    const newStep: AutomationStep = {
      ...step,
      id: uuidv4(),
      created_at: this.now(),
    };
    this.data.steps.unshift(newStep);
    await this.persist();
    return newStep;
  }

  async getSteps(runId?: string, applicationId?: string, limit: number = 50): Promise<AutomationStep[]> {
    await this.init();
    let list = this.data.steps;
    if (runId) list = list.filter((s) => s.run_id === runId);
    if (applicationId) list = list.filter((s) => s.application_id === applicationId);
    return list.slice(0, limit);
  }

  async addError(error: Omit<AutomationError, 'id' | 'created_at'>): Promise<AutomationError> {
    await this.init();
    const newErr: AutomationError = {
      ...error,
      id: uuidv4(),
      created_at: this.now(),
    };
    this.data.errors.unshift(newErr);
    await this.persist();
    return newErr;
  }

  async getErrors(runId?: string, limit: number = 50): Promise<AutomationError[]> {
    await this.init();
    let list = this.data.errors;
    if (runId) list = list.filter((e) => e.run_id === runId);
    return list.slice(0, limit);
  }

  async resolveError(errorId: string): Promise<boolean> {
    await this.init();
    const err = this.data.errors.find((e) => e.id === errorId);
    if (err) {
      err.resolved = true;
      await this.persist();
      return true;
    }
    return false;
  }

  // --- AI Caching & Logs ---
  async getCachedAI(cacheKey: string): Promise<any | null> {
    await this.init();
    return this.data.ai_cache[cacheKey] || null;
  }

  async logAIRequest(
    entry: Omit<AIRequestLog, 'id' | 'created_at'>,
    responseData?: any
  ): Promise<void> {
    await this.init();
    const newLog: AIRequestLog = {
      ...entry,
      id: uuidv4(),
      created_at: this.now(),
    };
    this.data.ai_logs.unshift(newLog);
    if (entry.cache_key && responseData) {
      this.data.ai_cache[entry.cache_key] = responseData;
    }
    await this.persist();
  }

  // --- Platform credentials ---
  async getCredentials(userId: string): Promise<PlatformCredential[]> {
    await this.init();
    return this.data.credentials.filter((c) => c.user_id === userId);
  }

  async getCredential(userId: string, platform: string): Promise<PlatformCredential | null> {
    await this.init();
    return this.data.credentials.find((c) => c.user_id === userId && c.platform === platform) || null;
  }

  async saveCredential(
    userId: string,
    platform: string,
    updates: Partial<Omit<PlatformCredential, 'id' | 'user_id' | 'platform' | 'created_at'>>
  ): Promise<PlatformCredential> {
    await this.init();
    const idx = this.data.credentials.findIndex((c) => c.user_id === userId && c.platform === platform);
    if (idx >= 0) {
      this.data.credentials[idx] = { ...this.data.credentials[idx], ...updates, updated_at: this.now() };
      await this.persist();
      return this.data.credentials[idx];
    }
    const created: PlatformCredential = {
      id: uuidv4(),
      user_id: userId,
      platform,
      username: '',
      status: 'not_connected',
      ...updates,
      created_at: this.now(),
      updated_at: this.now(),
    };
    this.data.credentials.push(created);
    await this.persist();
    return created;
  }

  async deleteCredential(userId: string, platform: string): Promise<boolean> {
    await this.init();
    const before = this.data.credentials.length;
    this.data.credentials = this.data.credentials.filter(
      (c) => !(c.user_id === userId && c.platform === platform)
    );
    if (this.data.credentials.length !== before) {
      await this.persist();
      return true;
    }
    return false;
  }

  // --- Screening answer bank ---
  async getAnswerBank(userId: string): Promise<AnswerBankEntry[]> {
    await this.init();
    return this.data.answer_bank
      .filter((a) => a.user_id === userId)
      .sort((a, b) => Number(Boolean(a.answer)) - Number(Boolean(b.answer)) || b.times_seen - a.times_seen);
  }

  async saveAnswerEntry(
    entry: Omit<AnswerBankEntry, 'id' | 'created_at' | 'updated_at' | 'times_seen'> & { times_seen?: number }
  ): Promise<AnswerBankEntry> {
    await this.init();
    const existing = this.data.answer_bank.find(
      (a) => a.user_id === entry.user_id && a.normalized === entry.normalized
    );
    if (existing) {
      existing.times_seen += 1;
      if (entry.answer !== undefined && entry.answer !== '') existing.answer = entry.answer;
      if (entry.options?.length) existing.options = entry.options;
      if (entry.field_type) existing.field_type = entry.field_type;
      existing.updated_at = this.now();
      await this.persist();
      return existing;
    }
    const created: AnswerBankEntry = {
      ...entry,
      id: uuidv4(),
      times_seen: entry.times_seen ?? 1,
      created_at: this.now(),
      updated_at: this.now(),
    };
    this.data.answer_bank.push(created);
    await this.persist();
    return created;
  }

  async updateAnswerEntry(id: string, updates: Partial<AnswerBankEntry>): Promise<AnswerBankEntry | null> {
    await this.init();
    const entry = this.data.answer_bank.find((a) => a.id === id);
    if (!entry) return null;
    const { id: _id, user_id: _u, created_at: _c, ...safe } = updates;
    Object.assign(entry, safe, { updated_at: this.now() });
    await this.persist();
    return entry;
  }

  async deleteAnswerEntry(userId: string, id: string): Promise<boolean> {
    await this.init();
    const before = this.data.answer_bank.length;
    this.data.answer_bank = this.data.answer_bank.filter((a) => !(a.id === id && a.user_id === userId));
    if (before !== this.data.answer_bank.length) {
      await this.persist();
      return true;
    }
    return false;
  }

  // --- Dashboard & Analytics ---
  async getDashboardStats(userId: string): Promise<DashboardStats> {
    await this.init();
    const pref = await this.getPreferences(userId);
    const apps = this.data.applications.filter((a) => a.user_id === userId);
    const matches = this.data.matches.filter((m) => m.user_id === userId);
    const activeRun = await this.getActiveRun(userId);

    let automationStatus: DashboardStats['automation_status'] = 'PAUSED';
    if (activeRun) {
      automationStatus = 'RUNNING';
    } else if (pref.automation_enabled) {
      automationStatus = 'IDLE';
    }

    return {
      jobs_found: this.data.jobs.length,
      matched: matches.filter((m) => m.is_eligible).length,
      applied: apps.filter((a) => a.status === 'SUBMITTED').length,
      failed: apps.filter((a) => a.status === 'FAILED').length,
      needs_attention: apps.filter((a) => a.status === 'REQUIRES_HUMAN_ACTION').length,
      resumes_generated: this.data.resume_versions.filter((rv) => rv.user_id === userId).length,
      automation_status: automationStatus,
      automation_mode: pref.automation_mode,
      recent_jobs: this.data.jobs.slice(0, 5),
      recent_applications: apps.slice(0, 5).map((a) => this.hydrateApplication(a)),
    };
  }

  async getAnalytics(userId: string): Promise<AnalyticsData> {
    await this.init();
    const apps = this.data.applications.filter((a) => a.user_id === userId);
    const matches = this.data.matches.filter((m) => m.user_id === userId);

    const days = 7;
    const jobsOverTime: { date: string; count: number }[] = [];
    const appsOverTime: { date: string; submitted: number; failed: number }[] = [];

    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split('T')[0];

      jobsOverTime.push({
        date: dateStr,
        count: this.data.jobs.filter((j) => j.created_at.startsWith(dateStr)).length,
      });
      appsOverTime.push({
        date: dateStr,
        submitted: apps.filter(
          (a) => a.status === 'SUBMITTED' && (a.applied_at || a.created_at).startsWith(dateStr)
        ).length,
        failed: apps.filter((a) => a.status === 'FAILED' && a.updated_at.startsWith(dateStr)).length,
      });
    }

    const matchDistribution = [
      { range: '90-100%', count: matches.filter((m) => m.overall_match_score >= 90).length },
      { range: '80-89%', count: matches.filter((m) => m.overall_match_score >= 80 && m.overall_match_score < 90).length },
      { range: '70-79%', count: matches.filter((m) => m.overall_match_score >= 70 && m.overall_match_score < 80).length },
      { range: 'Below 70%', count: matches.filter((m) => m.overall_match_score < 70).length },
    ];

    const roleMap: Record<string, number> = {};
    for (const app of apps) {
      const job = this.data.jobs.find((j) => j.id === app.job_id);
      if (job) {
        roleMap[job.title] = (roleMap[job.title] || 0) + 1;
      }
    }

    const skillCounts: Record<string, number> = {};
    for (const job of this.data.jobs) {
      for (const skill of job.skills) {
        skillCounts[skill] = (skillCounts[skill] || 0) + 1;
      }
    }

    const reasonMap: Record<string, number> = {};
    for (const app of apps) {
      if (app.status === 'FAILED' && app.failure_reason) {
        const reason = app.failure_reason.split('\n')[0].slice(0, 120);
        reasonMap[reason] = (reasonMap[reason] || 0) + 1;
      } else if (app.status === 'REQUIRES_HUMAN_ACTION') {
        const reason = (app.requires_human_reason || 'Human action required').split('\n')[0].slice(0, 120);
        reasonMap[reason] = (reasonMap[reason] || 0) + 1;
      }
    }

    return {
      jobs_over_time: jobsOverTime,
      applications_over_time: appsOverTime,
      match_distribution: matchDistribution,
      applications_by_role: Object.entries(roleMap).map(([role, count]) => ({ role, count })),
      top_skills: Object.entries(skillCounts)
        .map(([skill, count]) => ({ skill, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 8),
      failure_reasons: Object.entries(reasonMap).map(([reason, count]) => ({ reason, count })),
    };
  }

  async clearData(userId: string, keepJobs: boolean = true): Promise<void> {
    await this.init();
    const appIds = new Set(this.data.applications.filter((a) => a.user_id === userId).map((a) => a.id));
    const runIds = new Set(this.data.runs.filter((r) => r.user_id === userId).map((r) => r.id));
    const questionIds = new Set(
      this.data.questions.filter((q) => appIds.has(q.application_id)).map((q) => q.id)
    );

    this.data.applications = this.data.applications.filter((a) => a.user_id !== userId);
    this.data.resume_versions = this.data.resume_versions.filter((rv) => rv.user_id !== userId);
    this.data.matches = this.data.matches.filter((m) => m.user_id !== userId);
    this.data.runs = this.data.runs.filter((r) => r.user_id !== userId);
    this.data.steps = this.data.steps.filter(
      (s) => !runIds.has(s.run_id) && !(s.application_id && appIds.has(s.application_id))
    );
    this.data.errors = this.data.errors.filter(
      (e) => !(e.run_id && runIds.has(e.run_id)) && !(e.application_id && appIds.has(e.application_id))
    );
    this.data.questions = this.data.questions.filter((q) => !appIds.has(q.application_id));
    this.data.answers = this.data.answers.filter((a) => !questionIds.has(a.question_id));

    if (!keepJobs) {
      // Jobs are shared between users; only drop the ones nobody else applied to
      const stillReferenced = new Set(this.data.applications.map((a) => a.job_id));
      this.data.jobs = this.data.jobs.filter((j) => stillReferenced.has(j.id));
    }
    await this.persist();
    logger.info({ userId, keepJobs }, 'Cleared application, run and resume history for user');
  }

  async recoverInterrupted(): Promise<{ runs: number; applications: number }> {
    await this.init();
    let runs = 0;
    let applications = 0;
    for (const run of this.data.runs) {
      if (run.status === 'running') {
        run.status = 'failed';
        run.ended_at = this.now();
        run.error_message = 'Interrupted: the server stopped while this run was in progress.';
        runs++;
      }
    }
    for (const app of this.data.applications) {
      if (TRANSIENT_APPLICATION_STATUSES.includes(app.status)) {
        const interruptedIn = app.status.toLowerCase().replace(/_/g, ' ');
        app.status = 'FAILED';
        app.failure_reason = `Interrupted while ${interruptedIn}; it will be retried on the next run.`;
        app.updated_at = this.now();
        applications++;
      }
    }
    if (runs || applications) await this.persist();
    return { runs, applications };
  }
}
