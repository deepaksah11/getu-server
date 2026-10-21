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
  ApplicationStatus,
  PlatformCredential,
  AnswerBankEntry,
  LiveJobFilterOptions,
  JobBookmark,
} from '../types/index.js';

export type JobFilterOptions = LiveJobFilterOptions;

/** Statuses an application can be left in when the server stops mid-run. */
export const TRANSIENT_APPLICATION_STATUSES: ApplicationStatus[] = [
  'ANALYZING',
  'MATCHED',
  'RESUME_GENERATING',
  'RESUME_READY',
  'APPLYING',
];

export interface ApplicationFilterOptions {
  status?: ApplicationStatus;
  limit?: number;
  offset?: number;
}

export interface DashboardStats {
  jobs_found: number;
  matched: number;
  applied: number;
  failed: number;
  needs_attention: number;
  resumes_generated: number;
  automation_status: 'RUNNING' | 'PAUSED' | 'IDLE' | 'FAILED';
  automation_mode: 'dry-run' | 'production';
  recent_jobs: NormalizedJob[];
  recent_applications: Application[];
}

export interface AnalyticsData {
  jobs_over_time: { date: string; count: number }[];
  applications_over_time: { date: string; submitted: number; failed: number }[];
  match_distribution: { range: string; count: number }[];
  applications_by_role: { role: string; count: number }[];
  top_skills: { skill: string; count: number }[];
  failure_reasons: { reason: string; count: number }[];
}

export interface IRepository {
  init(): Promise<void>;

  // User & Preferences
  getUser(userId: string): Promise<User | null>;
  getUsers(): Promise<User[]>;
  createUser(email: string, fullName?: string): Promise<{ user: User; profile: CandidateProfile }>;
  getPreferences(userId: string): Promise<UserPreferences>;
  getAllPreferences(): Promise<UserPreferences[]>;
  updatePreferences(userId: string, prefs: Partial<UserPreferences>): Promise<UserPreferences>;

  // Candidate Profile
  getProfile(userId: string): Promise<CandidateProfile>;
  updateProfile(userId: string, profile: Partial<CandidateProfile>): Promise<CandidateProfile>;

  // Resumes
  getMasterResume(userId: string): Promise<MasterResume>;
  updateMasterResume(userId: string, content: MasterResumeContent): Promise<MasterResume>;
  getResumeVersions(userId: string, jobId?: string): Promise<ResumeVersion[]>;
  getResumeVersion(id: string): Promise<ResumeVersion | null>;
  createResumeVersion(version: Omit<ResumeVersion, 'id' | 'created_at' | 'updated_at'>): Promise<ResumeVersion>;
  deleteResumeVersion(id: string): Promise<boolean>;

  // Jobs
  getJobs(options?: JobFilterOptions): Promise<{ jobs: NormalizedJob[]; total: number }>;
  getJob(id: string): Promise<NormalizedJob | null>;
  getJobByExternalId(platform: string, externalId: string): Promise<NormalizedJob | null>;
  upsertJob(job: Omit<NormalizedJob, 'id' | 'created_at' | 'updated_at'> & { id?: string }): Promise<NormalizedJob>;
  updateJob(id: string, updates: Partial<NormalizedJob>): Promise<NormalizedJob | null>;
  bookmarkJob(userId: string, jobId: string, notes?: string): Promise<boolean>;
  unbookmarkJob(userId: string, jobId: string): Promise<boolean>;
  getBookmarks(userId: string): Promise<string[]>;

  // Job Matches
  getMatch(userId: string, jobId: string): Promise<JobMatch | null>;
  getMatches(userId: string): Promise<JobMatch[]>;
  saveMatch(match: Omit<JobMatch, 'id' | 'created_at'>): Promise<JobMatch>;

  // Applications
  getApplications(userId: string, options?: ApplicationFilterOptions): Promise<{ applications: Application[]; total: number }>;
  getApplication(id: string): Promise<Application | null>;
  getApplicationByJob(userId: string, jobId: string): Promise<Application | null>;
  createApplication(app: Omit<Application, 'id' | 'created_at' | 'updated_at'>): Promise<Application>;
  updateApplication(id: string, updates: Partial<Application>): Promise<Application>;

  // Application Questions & Answers
  getQuestions(applicationId: string): Promise<(ApplicationQuestion & { answer?: ApplicationAnswer })[]>;
  saveQuestion(question: Omit<ApplicationQuestion, 'id' | 'created_at'>): Promise<ApplicationQuestion>;
  saveAnswer(answer: Omit<ApplicationAnswer, 'id' | 'created_at'>): Promise<ApplicationAnswer>;

  // Automation
  createRun(run: Omit<AutomationRun, 'id' | 'started_at'>): Promise<AutomationRun>;
  updateRun(id: string, updates: Partial<AutomationRun>): Promise<AutomationRun>;
  getRuns(userId: string, limit?: number): Promise<AutomationRun[]>;
  getActiveRun(userId: string): Promise<AutomationRun | null>;
  addStep(step: Omit<AutomationStep, 'id' | 'created_at'>): Promise<AutomationStep>;
  getSteps(runId?: string, applicationId?: string, limit?: number): Promise<AutomationStep[]>;
  addError(error: Omit<AutomationError, 'id' | 'created_at'>): Promise<AutomationError>;
  getErrors(runId?: string, limit?: number): Promise<AutomationError[]>;
  resolveError(errorId: string): Promise<boolean>;

  // AI Caching & Logs
  getCachedAI(cacheKey: string): Promise<any | null>;
  logAIRequest(entry: Omit<AIRequestLog, 'id' | 'created_at'>, responseData?: any): Promise<void>;

  // Platform credentials (password stored encrypted)
  getCredentials(userId: string): Promise<PlatformCredential[]>;
  getCredential(userId: string, platform: string): Promise<PlatformCredential | null>;
  saveCredential(
    userId: string,
    platform: string,
    updates: Partial<Omit<PlatformCredential, 'id' | 'user_id' | 'platform' | 'created_at'>>
  ): Promise<PlatformCredential>;
  deleteCredential(userId: string, platform: string): Promise<boolean>;

  // Screening answer bank
  getAnswerBank(userId: string): Promise<AnswerBankEntry[]>;
  saveAnswerEntry(
    entry: Omit<AnswerBankEntry, 'id' | 'created_at' | 'updated_at' | 'times_seen'> & { times_seen?: number }
  ): Promise<AnswerBankEntry>;
  updateAnswerEntry(id: string, updates: Partial<AnswerBankEntry>): Promise<AnswerBankEntry | null>;
  deleteAnswerEntry(userId: string, id: string): Promise<boolean>;

  // Dashboard & Analytics
  getDashboardStats(userId: string): Promise<DashboardStats>;
  getAnalytics(userId: string): Promise<AnalyticsData>;

  // Data Management
  clearData(userId: string, keepJobs?: boolean): Promise<void>;
  /** Marks runs and applications left mid-flight by a crash or restart as failed. */
  recoverInterrupted(): Promise<{ runs: number; applications: number }>;
}
