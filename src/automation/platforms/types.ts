import { BrowserContext, Page } from 'playwright';
import { CandidateProfile, NormalizedJob, UserPreferences } from '../../types/index.js';
import { FormAnswerer } from '../engine/answerEngine.js';

export type DiscoveredJob = Omit<NormalizedJob, 'id' | 'created_at' | 'updated_at'>;

export interface SearchQuery {
  keywords: string[];
  /** May contain "Remote" */
  locations: string[];
  /** Maximum number of jobs to return */
  limit: number;
  postedWithinDays: number;
}

export interface SearchContext {
  query: SearchQuery;
  prefs: UserPreferences;
  profile: CandidateProfile;
  /** Browser page with the platform session, for platforms that only search inside a browser */
  getPage?: () => Promise<Page>;
  log: (message: string, details?: Record<string, any>) => void;
}

export interface LoginCredentials {
  username: string;
  password: string;
}

export type LoginOutcome =
  | { status: 'logged_in' }
  | { status: 'challenge'; reason: string }
  | { status: 'failed'; reason: string };

export interface ApplyContext {
  page: Page;
  context: BrowserContext;
  job: NormalizedJob;
  profile: CandidateProfile;
  prefs: UserPreferences;
  /** Job-specific tailored resume (PDF) */
  resumePath: string;
  coverLetter?: string;
  coverLetterPath?: string;
  dryRun: boolean;
  answerer: FormAnswerer;
  log: (step: string, details?: Record<string, any>) => void;
  screenshot: (label: string) => Promise<string | undefined>;
}

export type ApplyStatus =
  | 'SUBMITTED'
  | 'DRY_RUN_READY'
  | 'REQUIRES_HUMAN_ACTION'
  | 'FAILED'
  | 'ALREADY_APPLIED'
  | 'EXTERNAL';

export interface ApplyResult {
  status: ApplyStatus;
  message: string;
  /** true only when the platform displayed an explicit confirmation */
  verified?: boolean;
  confirmationNumber?: string;
  screenshotPath?: string;
  filled?: { label: string; value: string }[];
  unanswered?: string[];
  /** For EXTERNAL: where the platform sends applicants (company site / ATS) */
  externalUrl?: string;
}

export interface PlatformAdapter {
  id: string;
  name: string;
  description: string;
  requiresLogin: boolean;
  loginUrl?: string;
  /** The platform blocks headless browsers, so a (minimized) window is used */
  needsVisibleBrowser?: boolean;
  /** Shown in the UI next to the platform */
  notes?: string;
  /** Hidden from the platform picker (internal test board) */
  hidden?: boolean;
  /** Search runs inside the logged-in browser session (no public API) */
  searchNeedsBrowser?: boolean;
  canHandleUrl(url: string): boolean;
  search(ctx: SearchContext): Promise<DiscoveredJob[]>;
  /** Fetches the full description (and extra metadata) for a discovered job */
  enrich?(job: NormalizedJob, getPage?: () => Promise<Page>): Promise<Partial<DiscoveredJob> | null>;
  isLoggedIn?(page: Page): Promise<boolean>;
  login?(page: Page, creds: LoginCredentials): Promise<LoginOutcome>;
  apply(ctx: ApplyContext): Promise<ApplyResult>;
}
