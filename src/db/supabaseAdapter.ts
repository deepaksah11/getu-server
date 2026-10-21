import { createClient, SupabaseClient } from '@supabase/supabase-js';
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
} from '../types/index.js';
import {
  IRepository,
  JobFilterOptions,
  ApplicationFilterOptions,
  DashboardStats,
  AnalyticsData,
  TRANSIENT_APPLICATION_STATUSES,
} from './repository.js';
import { logger } from '../config/logger.js';
import { initialPreferences, initialProfile, initialMasterResume } from './seed.js';

export class SupabaseAdapter implements IRepository {
  private client: SupabaseClient;

  constructor(url: string, key: string) {
    this.client = createClient(url, key, {
      auth: { persistSession: false },
    });
  }

  private toError(err: any): Error {
    if (err instanceof Error) return err;
    const msg = err?.message || err?.error_description || (typeof err === 'object' ? JSON.stringify(err) : String(err));
    const e = new Error(msg);
    if (err?.code) (e as any).code = err.code;
    return e;
  }

  async init(): Promise<void> {
    try {
      const { error } = await this.client.from('users').select('id').limit(1);
      if (error) {
        throw this.toError(error);
      }
      logger.info('Supabase client initialized and connected to database');
    } catch (err: any) {
      throw this.toError(err);
    }
  }

  async getUser(userId: string): Promise<User | null> {
    const { data, error } = await this.client.from('users').select('*').eq('id', userId).single();
    if (error) return null;
    return data;
  }

  async getUsers(): Promise<User[]> {
    const { data } = await this.client.from('users').select('*');
    return data || [];
  }

  async createUser(email: string, fullName?: string): Promise<{ user: User; profile: CandidateProfile }> {
    const { data: user } = await this.client.from('users').insert({ email }).select().single();
    const profile = await this.getProfile(user.id);
    if (fullName) {
      await this.updateProfile(user.id, { full_name: fullName });
    }
    return { user, profile };
  }

  async getPreferences(userId: string): Promise<UserPreferences> {
    const { data, error } = await this.client
      .from('user_preferences')
      .select('*')
      .eq('user_id', userId)
      .single();
    if (error || !data) {
      const created = { ...initialPreferences, user_id: userId };
      const { data: inserted } = await this.client.from('user_preferences').insert(created).select().single();
      return inserted || created;
    }
    return data;
  }

  async updatePreferences(userId: string, prefs: Partial<UserPreferences>): Promise<UserPreferences> {
    const { data, error } = await this.client
      .from('user_preferences')
      .upsert({ ...prefs, user_id: userId, updated_at: new Date().toISOString() })
      .select()
      .single();
    if (error) throw this.toError(error);
    return data;
  }

  async getProfile(userId: string): Promise<CandidateProfile> {
    const { data, error } = await this.client
      .from('candidate_profiles')
      .select('*')
      .eq('user_id', userId)
      .single();
    if (error || !data) {
      return { ...initialProfile, user_id: userId };
    }
    return data;
  }

  async updateProfile(userId: string, profile: Partial<CandidateProfile>): Promise<CandidateProfile> {
    const { data, error } = await this.client
      .from('candidate_profiles')
      .upsert({ ...profile, user_id: userId, updated_at: new Date().toISOString() })
      .select()
      .single();
    if (error) throw this.toError(error);
    return data;
  }

  async getMasterResume(userId: string): Promise<MasterResume> {
    const { data, error } = await this.client
      .from('resumes')
      .select('*')
      .eq('user_id', userId)
      .eq('is_master', true)
      .single();
    if (error || !data) {
      return { ...initialMasterResume, user_id: userId };
    }
    return data;
  }

  async updateMasterResume(userId: string, content: MasterResumeContent): Promise<MasterResume> {
    const { data, error } = await this.client
      .from('resumes')
      .upsert({
        user_id: userId,
        title: 'Master Resume',
        is_master: true,
        content_json: content,
        updated_at: new Date().toISOString(),
      })
      .select()
      .single();
    if (error) throw this.toError(error);
    return data;
  }

  async getResumeVersions(userId: string, jobId?: string): Promise<ResumeVersion[]> {
    let query = this.client
      .from('resume_versions')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    if (jobId) query = query.eq('job_id', jobId);
    const { data, error } = await query;
    if (error) throw this.toError(error);
    return data || [];
  }

  async getResumeVersion(id: string): Promise<ResumeVersion | null> {
    const { data, error } = await this.client.from('resume_versions').select('*').eq('id', id).single();
    if (error) return null;
    return data;
  }

  async createResumeVersion(
    version: Omit<ResumeVersion, 'id' | 'created_at' | 'updated_at'>
  ): Promise<ResumeVersion> {
    const { data, error } = await this.client.from('resume_versions').insert(version).select().single();
    if (error) throw this.toError(error);
    return data;
  }

  async deleteResumeVersion(id: string): Promise<boolean> {
    const { error } = await this.client.from('resume_versions').delete().eq('id', id);
    return !error;
  }

  async getJobs(options?: JobFilterOptions): Promise<{ jobs: NormalizedJob[]; total: number }> {
    let query = this.client.from('jobs').select('*', { count: 'exact' });
    if (options?.keyword) query = query.ilike('title', `%${options.keyword}%`);
    if (options?.work_mode) query = query.eq('work_mode', options.work_mode);
    if (options?.platform) query = query.eq('platform', options.platform);
    const offset = options?.offset || 0;
    const limit = options?.limit || 50;
    query = query.range(offset, offset + limit - 1).order('created_at', { ascending: false });
    const { data, count, error } = await query;
    if (error) throw this.toError(error);
    return { jobs: data || [], total: count || 0 };
  }

  async getJob(id: string): Promise<NormalizedJob | null> {
    const { data, error } = await this.client.from('jobs').select('*').eq('id', id).single();
    if (error) return null;
    return data;
  }

  async getJobByExternalId(platform: string, externalId: string): Promise<NormalizedJob | null> {
    const { data, error } = await this.client
      .from('jobs')
      .select('*')
      .eq('platform', platform)
      .eq('external_id', externalId)
      .single();
    if (error) return null;
    return data;
  }

  async upsertJob(
    job: Omit<NormalizedJob, 'id' | 'created_at' | 'updated_at'> & { id?: string }
  ): Promise<NormalizedJob> {
    const { data, error } = await this.client
      .from('jobs')
      .upsert(job, { onConflict: 'platform,external_id' })
      .select()
      .single();
    if (error) throw this.toError(error);
    return data;
  }

  async updateJob(id: string, updates: Partial<NormalizedJob>): Promise<NormalizedJob | null> {
    const { data, error } = await this.client
      .from('jobs')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();
    if (error) return null;
    return data;
  }

  async bookmarkJob(userId: string, jobId: string, notes?: string): Promise<boolean> {
    const { error } = await this.client
      .from('job_bookmarks')
      .upsert({ user_id: userId, job_id: jobId, notes, created_at: new Date().toISOString() }, { onConflict: 'user_id,job_id' });
    return !error;
  }

  async unbookmarkJob(userId: string, jobId: string): Promise<boolean> {
    const { error } = await this.client
      .from('job_bookmarks')
      .delete()
      .eq('user_id', userId)
      .eq('job_id', jobId);
    return !error;
  }

  async getBookmarks(userId: string): Promise<string[]> {
    const { data, error } = await this.client
      .from('job_bookmarks')
      .select('job_id')
      .eq('user_id', userId);
    if (error || !data) return [];
    return data.map((b: any) => b.job_id);
  }

  async getMatch(userId: string, jobId: string): Promise<JobMatch | null> {
    const { data, error } = await this.client
      .from('job_matches')
      .select('*')
      .eq('user_id', userId)
      .eq('job_id', jobId)
      .single();
    if (error) return null;
    return data;
  }

  async getMatches(userId: string): Promise<JobMatch[]> {
    const { data, error } = await this.client.from('job_matches').select('*').eq('user_id', userId);
    if (error) throw this.toError(error);
    return data || [];
  }

  async saveMatch(match: Omit<JobMatch, 'id' | 'created_at'>): Promise<JobMatch> {
    const { data, error } = await this.client
      .from('job_matches')
      .upsert(match, { onConflict: 'user_id,job_id' })
      .select()
      .single();
    if (error) throw this.toError(error);
    return data;
  }

  async getApplications(
    userId: string,
    options?: ApplicationFilterOptions
  ): Promise<{ applications: Application[]; total: number }> {
    let query = this.client
      .from('applications')
      .select('*, job:jobs(*), resume_version:resume_versions(*)', { count: 'exact' })
      .eq('user_id', userId);
    if (options?.status) query = query.eq('status', options.status);
    const offset = options?.offset || 0;
    const limit = options?.limit || 50;
    query = query.range(offset, offset + limit - 1).order('created_at', { ascending: false });
    const { data, count, error } = await query;
    if (error) throw this.toError(error);
    return { applications: data || [], total: count || 0 };
  }

  async getApplication(id: string): Promise<Application | null> {
    const { data, error } = await this.client
      .from('applications')
      .select('*, job:jobs(*), resume_version:resume_versions(*)')
      .eq('id', id)
      .single();
    if (error) return null;
    return data;
  }

  async getApplicationByJob(userId: string, jobId: string): Promise<Application | null> {
    const { data, error } = await this.client
      .from('applications')
      .select('*, job:jobs(*), resume_version:resume_versions(*)')
      .eq('user_id', userId)
      .eq('job_id', jobId)
      .single();
    if (error) return null;
    return data;
  }

  async createApplication(app: Omit<Application, 'id' | 'created_at' | 'updated_at'>): Promise<Application> {
    const { data, error } = await this.client.from('applications').insert(app).select().single();
    if (error) throw this.toError(error);
    return data;
  }

  async updateApplication(id: string, updates: Partial<Application>): Promise<Application> {
    // Joined relations are not columns
    const { job: _j, resume_version: _r, match: _m, questions: _q, ...safe } = updates;
    const { data, error } = await this.client
      .from('applications')
      .update({ ...safe, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();
    if (error) throw this.toError(error);
    return data;
  }

  async getQuestions(applicationId: string): Promise<(ApplicationQuestion & { answer?: ApplicationAnswer })[]> {
    const { data, error } = await this.client
      .from('application_questions')
      .select('*, answer:application_answers(*)')
      .eq('application_id', applicationId);
    if (error) throw this.toError(error);
    return data || [];
  }

  async saveQuestion(question: Omit<ApplicationQuestion, 'id' | 'created_at'>): Promise<ApplicationQuestion> {
    const { data, error } = await this.client.from('application_questions').insert(question).select().single();
    if (error) throw this.toError(error);
    return data;
  }

  async saveAnswer(answer: Omit<ApplicationAnswer, 'id' | 'created_at'>): Promise<ApplicationAnswer> {
    const { data, error } = await this.client.from('application_answers').insert(answer).select().single();
    if (error) throw this.toError(error);
    return data;
  }

  async createRun(run: Omit<AutomationRun, 'id' | 'started_at'>): Promise<AutomationRun> {
    const { data, error } = await this.client.from('automation_runs').insert(run).select().single();
    if (error) throw this.toError(error);
    return data;
  }

  async updateRun(id: string, updates: Partial<AutomationRun>): Promise<AutomationRun> {
    const { data, error } = await this.client.from('automation_runs').update(updates).eq('id', id).select().single();
    if (error) throw this.toError(error);
    return data;
  }

  async getRuns(userId: string, limit: number = 20): Promise<AutomationRun[]> {
    const { data, error } = await this.client
      .from('automation_runs')
      .select('*')
      .eq('user_id', userId)
      .order('started_at', { ascending: false })
      .limit(limit);
    if (error) throw this.toError(error);
    return data || [];
  }

  async getActiveRun(userId: string): Promise<AutomationRun | null> {
    const { data, error } = await this.client
      .from('automation_runs')
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'running')
      .maybeSingle();
    if (error) return null;
    return data;
  }

  async addStep(step: Omit<AutomationStep, 'id' | 'created_at'>): Promise<AutomationStep> {
    const { data, error } = await this.client.from('automation_steps').insert(step).select().single();
    if (error) throw this.toError(error);
    return data;
  }

  async getSteps(runId?: string, applicationId?: string, limit: number = 50): Promise<AutomationStep[]> {
    let query = this.client.from('automation_steps').select('*').order('created_at', { ascending: false }).limit(limit);
    if (runId) query = query.eq('run_id', runId);
    if (applicationId) query = query.eq('application_id', applicationId);
    const { data, error } = await query;
    if (error) throw this.toError(error);
    return data || [];
  }

  async addError(error: Omit<AutomationError, 'id' | 'created_at'>): Promise<AutomationError> {
    const { data, error: err } = await this.client.from('automation_errors').insert(error).select().single();
    if (err) throw this.toError(err);
    return data;
  }

  async getErrors(runId?: string, limit: number = 50): Promise<AutomationError[]> {
    let query = this.client.from('automation_errors').select('*').order('created_at', { ascending: false }).limit(limit);
    if (runId) query = query.eq('run_id', runId);
    const { data, error } = await query;
    if (error) throw this.toError(error);
    return data || [];
  }

  async resolveError(errorId: string): Promise<boolean> {
    const { error } = await this.client.from('automation_errors').update({ resolved: true }).eq('id', errorId);
    return !error;
  }

  async getCachedAI(cacheKey: string): Promise<any | null> {
    const { data, error } = await this.client.from('ai_requests').select('raw_response').eq('cache_key', cacheKey).single();
    if (error || !data) return null;
    return data.raw_response;
  }

  async logAIRequest(entry: Omit<AIRequestLog, 'id' | 'created_at'>, responseData?: any): Promise<void> {
    await this.client.from('ai_requests').insert({
      ...entry,
      raw_response: responseData,
    });
  }

  async getDashboardStats(userId: string): Promise<DashboardStats> {
    // Basic aggregation
    const pref = await this.getPreferences(userId);
    const { count: jobsFound } = await this.client.from('jobs').select('*', { count: 'exact', head: true });
    const { count: applied } = await this.client.from('applications').select('*', { count: 'exact', head: true }).eq('user_id', userId).eq('status', 'SUBMITTED');
    const { count: failed } = await this.client.from('applications').select('*', { count: 'exact', head: true }).eq('user_id', userId).eq('status', 'FAILED');
    const { count: needsAttention } = await this.client.from('applications').select('*', { count: 'exact', head: true }).eq('user_id', userId).eq('status', 'REQUIRES_HUMAN_ACTION');
    const { count: resumesCount } = await this.client.from('resume_versions').select('*', { count: 'exact', head: true }).eq('user_id', userId);
    const { count: matchedCount } = await this.client.from('job_matches').select('*', { count: 'exact', head: true }).eq('user_id', userId).eq('is_eligible', true);

    const activeRun = await this.getActiveRun(userId);
    const { data: recentJobs } = await this.client.from('jobs').select('*').order('created_at', { ascending: false }).limit(5);
    const { data: recentApps } = await this.client.from('applications').select('*, job:jobs(*)').eq('user_id', userId).order('created_at', { ascending: false }).limit(5);

    return {
      jobs_found: jobsFound || 0,
      matched: matchedCount || 0,
      applied: applied || 0,
      failed: failed || 0,
      needs_attention: needsAttention || 0,
      resumes_generated: resumesCount || 0,
      automation_status: activeRun ? 'RUNNING' : pref.automation_enabled ? 'IDLE' : 'PAUSED',
      automation_mode: pref.automation_mode,
      recent_jobs: recentJobs || [],
      recent_applications: recentApps || [],
    };
  }

  async getAnalytics(userId: string): Promise<AnalyticsData> {
    const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const { data: apps } = await this.client
      .from('applications')
      .select('status, applied_at, created_at, updated_at, failure_reason, requires_human_reason, job:jobs(title)')
      .eq('user_id', userId);
    const { data: matches } = await this.client
      .from('job_matches')
      .select('overall_match_score')
      .eq('user_id', userId);
    const { data: jobs } = await this.client.from('jobs').select('created_at, skills').gte('created_at', since);

    const days: string[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      days.push(d.toISOString().split('T')[0]);
    }
    const appList = (apps || []) as any[];
    const scores = (matches || []).map((m: any) => m.overall_match_score as number);
    const roleMap: Record<string, number> = {};
    const reasonMap: Record<string, number> = {};
    for (const a of appList) {
      const title = a.job?.title;
      if (title) roleMap[title] = (roleMap[title] || 0) + 1;
      const reason =
        a.status === 'FAILED' ? a.failure_reason : a.status === 'REQUIRES_HUMAN_ACTION' ? a.requires_human_reason : null;
      if (reason) {
        const key = String(reason).split('\n')[0].slice(0, 120);
        reasonMap[key] = (reasonMap[key] || 0) + 1;
      }
    }
    const skillCounts: Record<string, number> = {};
    for (const j of (jobs || []) as any[]) {
      for (const s of j.skills || []) skillCounts[s] = (skillCounts[s] || 0) + 1;
    }

    return {
      jobs_over_time: days.map((date) => ({
        date,
        count: ((jobs || []) as any[]).filter((j) => String(j.created_at).startsWith(date)).length,
      })),
      applications_over_time: days.map((date) => ({
        date,
        submitted: appList.filter((a) => a.status === 'SUBMITTED' && String(a.applied_at || a.created_at).startsWith(date)).length,
        failed: appList.filter((a) => a.status === 'FAILED' && String(a.updated_at).startsWith(date)).length,
      })),
      match_distribution: [
        { range: '90-100%', count: scores.filter((s) => s >= 90).length },
        { range: '80-89%', count: scores.filter((s) => s >= 80 && s < 90).length },
        { range: '70-79%', count: scores.filter((s) => s >= 70 && s < 80).length },
        { range: 'Below 70%', count: scores.filter((s) => s < 70).length },
      ],
      applications_by_role: Object.entries(roleMap).map(([role, count]) => ({ role, count })),
      top_skills: Object.entries(skillCounts)
        .map(([skill, count]) => ({ skill, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 8),
      failure_reasons: Object.entries(reasonMap).map(([reason, count]) => ({ reason, count })),
    };
  }

  async getAllPreferences(): Promise<UserPreferences[]> {
    const { data, error } = await this.client.from('user_preferences').select('*');
    if (error) throw this.toError(error);
    return data || [];
  }

  async getCredentials(userId: string): Promise<PlatformCredential[]> {
    const { data, error } = await this.client.from('platform_credentials').select('*').eq('user_id', userId);
    if (error) throw this.toError(error);
    return data || [];
  }

  async getCredential(userId: string, platform: string): Promise<PlatformCredential | null> {
    const { data, error } = await this.client
      .from('platform_credentials')
      .select('*')
      .eq('user_id', userId)
      .eq('platform', platform)
      .maybeSingle();
    if (error) return null;
    return data;
  }

  async saveCredential(
    userId: string,
    platform: string,
    updates: Partial<Omit<PlatformCredential, 'id' | 'user_id' | 'platform' | 'created_at'>>
  ): Promise<PlatformCredential> {
    const { data, error } = await this.client
      .from('platform_credentials')
      .upsert(
        { ...updates, user_id: userId, platform, updated_at: new Date().toISOString() },
        { onConflict: 'user_id,platform' }
      )
      .select()
      .single();
    if (error) throw this.toError(error);
    return data;
  }

  async deleteCredential(userId: string, platform: string): Promise<boolean> {
    const { error } = await this.client
      .from('platform_credentials')
      .delete()
      .eq('user_id', userId)
      .eq('platform', platform);
    return !error;
  }

  async getAnswerBank(userId: string): Promise<AnswerBankEntry[]> {
    const { data, error } = await this.client
      .from('answer_bank')
      .select('*')
      .eq('user_id', userId)
      .order('times_seen', { ascending: false });
    if (error) throw this.toError(error);
    return data || [];
  }

  async saveAnswerEntry(
    entry: Omit<AnswerBankEntry, 'id' | 'created_at' | 'updated_at' | 'times_seen'> & { times_seen?: number }
  ): Promise<AnswerBankEntry> {
    const { data: existing } = await this.client
      .from('answer_bank')
      .select('*')
      .eq('user_id', entry.user_id)
      .eq('normalized', entry.normalized)
      .maybeSingle();
    if (existing) {
      const { data, error } = await this.client
        .from('answer_bank')
        .update({
          times_seen: (existing.times_seen || 0) + 1,
          answer: entry.answer || existing.answer,
          options: entry.options?.length ? entry.options : existing.options,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.id)
        .select()
        .single();
      if (error) throw this.toError(error);
      return data;
    }
    const { data, error } = await this.client
      .from('answer_bank')
      .insert({ ...entry, times_seen: entry.times_seen ?? 1 })
      .select()
      .single();
    if (error) throw this.toError(error);
    return data;
  }

  async updateAnswerEntry(id: string, updates: Partial<AnswerBankEntry>): Promise<AnswerBankEntry | null> {
    const { id: _id, user_id: _u, created_at: _c, ...safe } = updates;
    const { data, error } = await this.client
      .from('answer_bank')
      .update({ ...safe, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();
    if (error) return null;
    return data;
  }

  async deleteAnswerEntry(userId: string, id: string): Promise<boolean> {
    const { error } = await this.client.from('answer_bank').delete().eq('id', id).eq('user_id', userId);
    return !error;
  }

  async clearData(userId: string, _keepJobs: boolean = true): Promise<void> {
    await this.client.from('applications').delete().eq('user_id', userId);
    await this.client.from('resume_versions').delete().eq('user_id', userId);
    await this.client.from('job_matches').delete().eq('user_id', userId);
    await this.client.from('automation_runs').delete().eq('user_id', userId);
  }

  async recoverInterrupted(): Promise<{ runs: number; applications: number }> {
    try {
      const now = new Date().toISOString();
      const { data: runs, error: runsErr } = await this.client
        .from('automation_runs')
        .update({
          status: 'failed',
          ended_at: now,
          error_message: 'Interrupted: the server stopped while this run was in progress.',
        })
        .eq('status', 'running')
        .select('id');
      if (runsErr) {
        logger.warn({ err: runsErr?.message || runsErr }, 'Failed updating interrupted runs');
      }

      const { data: apps, error: appsErr } = await this.client
        .from('applications')
        .update({
          status: 'FAILED',
          failure_reason: 'Interrupted mid-run; it will be retried on the next run.',
          updated_at: now,
        })
        .in('status', TRANSIENT_APPLICATION_STATUSES)
        .select('id');
      if (appsErr) {
        logger.warn({ err: appsErr?.message || appsErr }, 'Failed updating interrupted applications');
      }

      return { runs: runs?.length || 0, applications: apps?.length || 0 };
    } catch (err: any) {
      logger.warn({ err: err?.message || err }, 'Supabase recoverInterrupted failed');
      return { runs: 0, applications: 0 };
    }
  }
}
