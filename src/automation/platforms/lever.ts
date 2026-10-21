import { extractSkillsFromText } from '../../ai/skillDictionary.js';
import { DEFAULT_LEVER_COMPANIES } from '../../db/seed.js';
import { firstVisible, sleep } from '../engine/pageUtils.js';
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
} from './shared.js';
import { ApplyContext, DiscoveredJob, PlatformAdapter } from './types.js';

interface LeverPosting {
  id: string;
  text: string;
  categories?: { location?: string; commitment?: string; team?: string; allLocations?: string[] };
  workplaceType?: string;
  createdAt?: number;
  hostedUrl: string;
  applyUrl: string;
  descriptionPlain?: string;
  lists?: { text: string; content: string }[];
  additionalPlain?: string;
  salaryRange?: { min?: number; max?: number; currency?: string; interval?: string };
}

function toDiscovered(company: string, p: LeverPosting): DiscoveredJob {
  const lists = (p.lists || []).map((l) => `${l.text}\n${htmlToText(l.content)}`).join('\n\n');
  const description = [p.descriptionPlain || '', lists, p.additionalPlain || ''].filter(Boolean).join('\n\n').trim();
  const locations = p.categories?.allLocations?.length ? p.categories.allLocations : p.categories?.location ? [p.categories.location] : [];
  const workplace = (p.workplaceType || '').toLowerCase();
  const salary = p.salaryRange?.min
    ? `${p.salaryRange.currency || ''} ${p.salaryRange.min}${p.salaryRange.max ? ` - ${p.salaryRange.max}` : ''} ${p.salaryRange.interval || ''}`.trim()
    : 'Not disclosed';
  return {
    external_id: `${company}:${p.id}`,
    platform: 'Lever',
    title: p.text,
    company: titleCase(company),
    locations,
    work_mode: workplace === 'remote' ? 'Remote' : workplace === 'hybrid' ? 'Hybrid' : workplace === 'on-site' ? 'Onsite' : 'Flexible',
    experience_required: 'Not specified',
    salary,
    description,
    requirements: (p.lists || []).flatMap((l) => htmlToText(l.content).split('\n').map((s) => s.replace(/^•\s*/, '').trim())).filter((s) => s.length > 10).slice(0, 15),
    skills: extractSkillsFromText(description).slice(0, 20),
    application_url: p.applyUrl || `${p.hostedUrl}/apply`,
    posted_at: p.createdAt ? new Date(p.createdAt).toISOString() : undefined,
    extracted_metadata: { company, team: p.categories?.team, commitment: p.categories?.commitment },
    is_active: true,
  };
}

/** Lever needs the location picked from its autocomplete list, not just typed. */
async function pickLeverLocation(ctx: ApplyContext): Promise<void> {
  const input = await firstVisible(ctx.page, ['#location-input', 'input[name="location"]']);
  if (!input || !ctx.profile.location) return;
  const hasDropdown = await ctx.page.locator('.dropdown-location, .dropdown-results').count().catch(() => 0);
  if (!hasDropdown && !(await ctx.page.locator('input[name="selectedLocation"]').count().catch(() => 0))) return;
  await input.fill('');
  await input.pressSequentially(ctx.profile.location.split(',')[0].slice(0, 30), { delay: 60 });
  for (let i = 0; i < 10; i++) {
    await sleep(400);
    const option = await firstVisible(ctx.page, ['.dropdown-location', '.dropdown-results div[role="option"]', '.dropdown-results li']);
    if (option) {
      await option.click().catch(() => {});
      return;
    }
  }
}

export const leverAdapter: PlatformAdapter = {
  id: 'Lever',
  name: 'Lever',
  description: 'Company boards hosted on Lever (Palantir, Spotify, Meesho, Paytm, CRED...). Public forms, no login.',
  requiresLogin: false,
  notes: 'Searches the company boards listed in Settings.',

  canHandleUrl(url: string) {
    return /jobs\.lever\.co\//i.test(url);
  },

  async search(ctx) {
    const companies = ctx.prefs.lever_companies?.length ? ctx.prefs.lever_companies : DEFAULT_LEVER_COMPANIES;
    const { keywords, locations, limit, postedWithinDays } = ctx.query;
    const lists = await mapLimit(companies, 6, async (company) => ({
      company,
      postings: await fetchJson<LeverPosting[]>(`https://api.lever.co/v0/postings/${encodeURIComponent(company)}?mode=json`),
    }));

    const matched: { company: string; posting: LeverPosting; score: number }[] = [];
    for (const list of lists) {
      if (!list) continue;
      for (const posting of list.postings) {
        if (!titleMatchesAny(posting.text, keywords)) continue;
        const locs = posting.categories?.allLocations?.length ? posting.categories.allLocations : [posting.categories?.location || ''];
        if (!locationMatches(locs, locations, (posting.workplaceType || '').toLowerCase() === 'remote')) continue;
        if (postedWithinDays > 0 && posting.createdAt && daysAgo(posting.createdAt) > Math.max(postedWithinDays * 4, 60)) continue;
        matched.push({ company: list.company, posting, score: Math.max(0, ...keywords.map((k) => titleMatchScore(posting.text, k))) });
      }
    }
    ctx.log('lever_candidates', { companies: companies.length, matched: matched.length });
    matched.sort((a, b) => b.score - a.score || (b.posting.createdAt || 0) - (a.posting.createdAt || 0));
    return matched.slice(0, limit).map((m) => toDiscovered(m.company, m.posting));
  },

  async apply(ctx) {
    const url = ctx.job.application_url.endsWith('/apply') ? ctx.job.application_url : `${ctx.job.application_url.replace(/\/$/, '')}/apply`;
    await ctx.page.goto(url, { waitUntil: 'domcontentloaded' });
    return applySinglePageForm(ctx, {
      formScope: ['#application-form', 'form[action*="/apply"]', 'form.application-form'],
      submitButtons: ['#btn-submit', 'button[data-qa="btn-submit"]', 'button:has-text("Submit application")', 'button[type="submit"]'],
      afterFill: pickLeverLocation,
      verify: {
        successText: /application submitted|thank you for applying|thanks for applying/i,
        successUrl: /\/thanks/i,
        timeoutMs: 20000,
      },
    });
  },
};
