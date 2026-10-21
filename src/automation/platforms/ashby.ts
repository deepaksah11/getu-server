import { extractSkillsFromText } from '../../ai/skillDictionary.js';
import { DEFAULT_ASHBY_BOARDS } from '../../db/seed.js';
import { applySinglePageForm } from './singlePageForm.js';
import {
  daysAgo,
  fetchJson,
  locationMatches,
  mapLimit,
  titleCase,
  titleMatchesAny,
  titleMatchScore,
} from './shared.js';
import { DiscoveredJob, PlatformAdapter } from './types.js';

interface AshbyJob {
  id: string;
  title: string;
  department?: string;
  team?: string;
  employmentType?: string;
  location?: string;
  secondaryLocations?: { location: string }[];
  publishedAt?: string;
  isRemote?: boolean;
  workplaceType?: string;
  jobUrl: string;
  applyUrl: string;
  descriptionPlain?: string;
  isListed?: boolean;
  compensation?: { compensationTierSummary?: string };
}

function toDiscovered(board: string, j: AshbyJob): DiscoveredJob {
  const locations = [j.location, ...(j.secondaryLocations || []).map((s) => s.location)].filter(Boolean) as string[];
  const workplace = (j.workplaceType || '').toLowerCase();
  const description = (j.descriptionPlain || '').trim();
  return {
    external_id: `${board}:${j.id}`,
    platform: 'Ashby',
    title: j.title.trim(),
    company: titleCase(board),
    locations,
    work_mode: workplace === 'remote' || (j.isRemote && workplace !== 'hybrid') ? 'Remote' : workplace === 'hybrid' ? 'Hybrid' : workplace === 'onsite' ? 'Onsite' : 'Flexible',
    experience_required: 'Not specified',
    salary: j.compensation?.compensationTierSummary || 'Not disclosed',
    description,
    requirements: [],
    skills: extractSkillsFromText(description).slice(0, 20),
    application_url: j.applyUrl || `${j.jobUrl}/application`,
    posted_at: j.publishedAt,
    extracted_metadata: { board, department: j.department, team: j.team, employment_type: j.employmentType },
    is_active: true,
  };
}

export const ashbyAdapter: PlatformAdapter = {
  id: 'Ashby',
  name: 'Ashby',
  description: 'Startup boards hosted on Ashby (OpenAI, Notion, Ramp, Cursor, Sarvam...). Public forms, no login.',
  requiresLogin: false,
  notes: 'Searches the company boards listed in Settings.',

  canHandleUrl(url: string) {
    return /jobs\.ashbyhq\.com\//i.test(url);
  },

  async search(ctx) {
    const boards = ctx.prefs.ashby_boards?.length ? ctx.prefs.ashby_boards : DEFAULT_ASHBY_BOARDS;
    const { keywords, locations, limit, postedWithinDays } = ctx.query;
    const lists = await mapLimit(boards, 6, async (board) => ({
      board,
      jobs: (await fetchJson<{ jobs: AshbyJob[] }>(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board)}?includeCompensation=true`)).jobs || [],
    }));

    const matched: { board: string; job: AshbyJob; score: number }[] = [];
    for (const list of lists) {
      if (!list) continue;
      for (const job of list.jobs) {
        if (job.isListed === false) continue;
        if (!titleMatchesAny(job.title, keywords)) continue;
        const locs = [job.location || '', ...(job.secondaryLocations || []).map((s) => s.location)];
        if (!locationMatches(locs, locations, job.isRemote === true)) continue;
        if (postedWithinDays > 0 && job.publishedAt && daysAgo(job.publishedAt) > Math.max(postedWithinDays * 4, 60)) continue;
        matched.push({ board: list.board, job, score: Math.max(0, ...keywords.map((k) => titleMatchScore(job.title, k))) });
      }
    }
    ctx.log('ashby_candidates', { boards: boards.length, matched: matched.length });
    matched.sort((a, b) => b.score - a.score || Date.parse(b.job.publishedAt || '0') - Date.parse(a.job.publishedAt || '0'));
    return matched.slice(0, limit).map((m) => toDiscovered(m.board, m.job));
  },

  async apply(ctx) {
    await ctx.page.goto(ctx.job.application_url, { waitUntil: 'domcontentloaded' });
    return applySinglePageForm(ctx, {
      formScope: ['form:has(input[name="_systemfield_email"])', '[class*="application-form"]', 'form:has(input[type="file"])'],
      openFormButtons: ['a:has-text("Apply for this Job")', 'button:has-text("Apply for this Job")', 'a[href$="/application"]'],
      submitButtons: ['button.ashby-application-form-submit-button', 'button:has-text("Submit Application")', 'button[type="submit"]'],
      verify: {
        successText: /thank(s| you) for (applying|your application)|application (was )?(successfully )?(submitted|received)/i,
        timeoutMs: 20000,
      },
    });
  },
};
