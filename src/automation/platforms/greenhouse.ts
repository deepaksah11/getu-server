import { extractSkillsFromText } from '../../ai/skillDictionary.js';
import { DEFAULT_GREENHOUSE_BOARDS } from '../../db/seed.js';
import { NormalizedJob } from '../../types/index.js';
import { applySinglePageForm } from './singlePageForm.js';
import {
  daysAgo,
  fetchJson,
  htmlToText,
  locationMatches,
  mapLimit,
  titleCase,
  titleMatchesAny,
  titleMatchScore,
  workModeFromText,
} from './shared.js';
import { DiscoveredJob, PlatformAdapter } from './types.js';

interface GhListJob {
  id: number;
  title: string;
  absolute_url: string;
  location?: { name?: string };
  updated_at?: string;
  first_published?: string;
  company_name?: string;
}

interface GhJobDetail extends GhListJob {
  content?: string;
  questions?: { label: string; required: boolean; fields: { name: string; type: string; values: { label: string; value: any }[] }[] }[];
}

const API = 'https://boards-api.greenhouse.io/v1/boards';

function toDiscovered(board: string, job: GhJobDetail): DiscoveredJob {
  const description = htmlToText(job.content || '');
  const location = job.location?.name || '';
  return {
    external_id: `${board}:${job.id}`,
    platform: 'Greenhouse',
    title: job.title,
    company: job.company_name || titleCase(board),
    locations: location ? location.split(/;|\|/).map((l) => l.trim()).filter(Boolean) : [],
    work_mode: workModeFromText(`${location} ${job.title}`),
    experience_required: 'Not specified',
    salary: 'Not disclosed',
    description,
    requirements: [],
    skills: extractSkillsFromText(description).slice(0, 20),
    application_url: `https://job-boards.greenhouse.io/${board}/jobs/${job.id}`,
    posted_at: job.first_published || job.updated_at,
    extracted_metadata: {
      board,
      questions: (job.questions || []).map((q) => ({
        label: q.label,
        required: q.required,
        type: q.fields?.[0]?.type,
        options: q.fields?.[0]?.values?.map((v) => v.label),
      })),
    },
    is_active: true,
  };
}

export const greenhouseAdapter: PlatformAdapter = {
  id: 'Greenhouse',
  name: 'Greenhouse',
  description: 'Career boards of companies hiring through Greenhouse (Databricks, Cloudflare, Stripe, Groww...). Public forms, no login.',
  requiresLogin: false,
  notes: 'Searches the company boards listed in Settings. Some companies email a security code after submitting; those applications wait for you.',

  canHandleUrl(url: string) {
    return /greenhouse\.io\//i.test(url) || /[?&]gh_jid=\d+/.test(url);
  },

  async search(ctx) {
    const boards = ctx.prefs.greenhouse_boards?.length ? ctx.prefs.greenhouse_boards : DEFAULT_GREENHOUSE_BOARDS;
    const { keywords, locations, limit, postedWithinDays } = ctx.query;

    const lists = await mapLimit(boards, 6, async (board) => {
      const data = await fetchJson<{ jobs: GhListJob[] }>(`${API}/${encodeURIComponent(board)}/jobs`);
      return { board, jobs: data.jobs || [] };
    });

    const candidates: { board: string; job: GhListJob; score: number }[] = [];
    for (const list of lists) {
      if (!list) continue;
      for (const job of list.jobs) {
        if (!titleMatchesAny(job.title, keywords)) continue;
        const loc = job.location?.name || '';
        if (!locationMatches([loc], locations)) continue;
        const published = job.first_published || job.updated_at;
        // Boards only list open roles; the window is generous because evergreen roles stay open for weeks
        if (postedWithinDays > 0 && published && daysAgo(published) > Math.max(postedWithinDays * 4, 60)) continue;
        const score = Math.max(...keywords.map((k) => titleMatchScore(job.title, k)), 0);
        candidates.push({ board: list.board, job, score });
      }
    }
    ctx.log('greenhouse_candidates', { boards: boards.length, matched: candidates.length });

    candidates.sort(
      (a, b) => b.score - a.score || Date.parse(b.job.first_published || b.job.updated_at || '0') - Date.parse(a.job.first_published || a.job.updated_at || '0')
    );
    const top = candidates.slice(0, limit);
    const details = await mapLimit(top, 5, async ({ board, job }) => {
      const detail = await fetchJson<GhJobDetail>(`${API}/${encodeURIComponent(board)}/jobs/${job.id}?questions=true`);
      return toDiscovered(board, { ...job, ...detail });
    });
    return details.filter((d): d is DiscoveredJob => d !== null);
  },

  async enrich(job: NormalizedJob) {
    if (job.description && job.description.length > 300) return null;
    const [board, id] = job.external_id.split(':');
    if (!board || !id) return null;
    const detail = await fetchJson<GhJobDetail>(`${API}/${encodeURIComponent(board)}/jobs/${id}?questions=true`);
    return toDiscovered(board, detail);
  },

  async apply(ctx) {
    await ctx.page.goto(ctx.job.application_url, { waitUntil: 'domcontentloaded' });
    return applySinglePageForm(ctx, {
      formScope: ['#application-form', 'form#application_form', 'form:has(#first_name)', 'form[action*="greenhouse"]'],
      openFormButtons: ['button:has-text("Apply")', 'a:has-text("Apply for this job")', '#apply_button'],
      submitButtons: ['button[type="submit"]:has-text("Submit")', '#submit_app', 'input[type="submit"]', 'button:has-text("Submit application")'],
      verify: {
        successText: /thank you for applying|application (has been )?(submitted|received)|we('ve| have) received your application/i,
        successUrl: /\/confirmation/i,
        timeoutMs: 20000,
      },
    });
  },
};
