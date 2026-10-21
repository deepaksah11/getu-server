import { decodeHtml } from '../engine/pageUtils.js';

export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export async function fetchText(url: string, options: { headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html,application/json;q=0.9,*/*;q=0.8', ...options.headers },
    signal: AbortSignal.timeout(options.timeoutMs ?? 20000),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return res.text();
}

export async function fetchJson<T>(url: string, options: { headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<T> {
  const text = await fetchText(url, { ...options, headers: { Accept: 'application/json', ...options.headers } });
  return JSON.parse(text) as T;
}

/** Runs `fn` over items with at most `limit` in flight. Rejections become null. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<(R | null)[]> {
  const results: (R | null)[] = new Array(items.length).fill(null);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = await fn(items[index]);
      } catch {
        results[index] = null;
      }
    }
  });
  await Promise.all(workers);
  return results;
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function htmlToText(html: string): string {
  let s = html || '';
  // Some APIs (Greenhouse) return entity-encoded HTML: decode the markup before stripping tags
  if (/&lt;\/?[a-z]/i.test(s)) {
    s = s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  }
  return decodeHtml(s);
}

export function titleCase(slug: string): string {
  return slug
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// --- Title matching -----------------------------------------------------------------

const ROLE_SYNONYMS: Record<string, string> = {
  developer: 'engineer',
  programmer: 'engineer',
  sde: 'engineer',
  dev: 'engineer',
  swe: 'engineer',
  engineering: 'engineer',
};

function normalizeTitle(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/front[\s-]?end/g, 'frontend')
    .replace(/back[\s-]?end/g, 'backend')
    .replace(/full[\s-]?stack/g, 'fullstack')
    .replace(/machine learning/g, 'ml')
    .replace(/artificial intelligence/g, 'ai')
    .replace(/node\.?js/g, 'node')
    .replace(/react\.?js/g, 'react')
    .replace(/\bsr\.?\b/g, 'senior')
    .replace(/\bjr\.?\b/g, 'junior')
    .replace(/[^a-z0-9+#]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((t) => ROLE_SYNONYMS[t] || t);
}

const IGNORED_TITLE_TOKENS = new Set(['senior', 'junior', 'lead', 'staff', 'principal', 'associate', 'ii', 'iii', 'iv', 'i', 'the', 'and', 'of', 'a', 'mid', 'level', 'sr', 'jr']);

/** 0..1 — share of the keyword's meaningful tokens that appear in the job title. */
export function titleMatchScore(title: string, keyword: string): number {
  const titleTokens = new Set(normalizeTitle(title));
  const keyTokens = normalizeTitle(keyword).filter((t) => !IGNORED_TITLE_TOKENS.has(t));
  if (keyTokens.length === 0) return 0;
  const hits = keyTokens.filter((t) => titleTokens.has(t)).length;
  return hits / keyTokens.length;
}

export function titleMatchesAny(title: string, keywords: string[], threshold = 0.66): boolean {
  if (keywords.length === 0) return true;
  return keywords.some((k) => titleMatchScore(title, k) >= threshold);
}

// --- Location matching ----------------------------------------------------------------

const CITY_ALIASES: Record<string, string[]> = {
  bangalore: ['bengaluru', 'bangalore'],
  bengaluru: ['bengaluru', 'bangalore'],
  gurgaon: ['gurgaon', 'gurugram'],
  gurugram: ['gurgaon', 'gurugram'],
  mumbai: ['mumbai', 'bombay', 'navi mumbai', 'thane'],
  delhi: ['delhi', 'new delhi', 'ncr', 'noida', 'gurgaon', 'gurugram'],
  'new delhi': ['delhi', 'new delhi', 'ncr'],
  ncr: ['delhi', 'new delhi', 'ncr', 'noida', 'gurgaon', 'gurugram', 'ghaziabad', 'faridabad'],
  chennai: ['chennai', 'madras'],
  kolkata: ['kolkata', 'calcutta'],
  'san francisco': ['san francisco', 'sf', 'bay area'],
  'new york': ['new york', 'nyc', 'ny'],
};

const INDIA_HINT = /india|bengaluru|bangalore|mumbai|delhi|noida|gurgaon|gurugram|hyderabad|pune|chennai|kolkata|ahmedabad|jaipur|kochi|indore|chandigarh|coimbatore/i;

export function isRemoteText(text: string): boolean {
  return /\bremote\b|work from home|\bwfh\b|anywhere/i.test(text);
}

const FOREIGN_COUNTRY =
  /\b(us|usa|u\.s\.|united states|americas|north america|canada|uk|united kingdom|england|ireland|europe|emea|eu|germany|france|netherlands|spain|portugal|poland|sweden|denmark|norway|finland|switzerland|italy|israel|australia|new zealand|brazil|mexico|argentina|colombia|chile|latam|japan|korea|china|philippines|vietnam|indonesia|singapore|uae|united arab emirates|south africa)\b/i;
const FOREIGN_CITY =
  /\b(san francisco|new york|nyc|seattle|austin|boston|chicago|denver|los angeles|miami|atlanta|dallas|houston|washington|toronto|vancouver|montreal|london|berlin|munich|dublin|amsterdam|paris|madrid|barcelona|lisbon|warsaw|stockholm|copenhagen|zurich|tel aviv|sydney|melbourne|tokyo|seoul|sao paulo|são paulo|mexico city|dubai)\b/i;
// Two-letter US state codes as written in "Austin, TX - Remote" (case-sensitive on purpose)
const US_STATE_CODE =
  /\b(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\b/;

/** True when any job location satisfies any wanted location ("Remote" matches remote jobs). */
export function locationMatches(jobLocations: string[], wanted: string[], jobIsRemote = false): boolean {
  const cleanedWanted = wanted.map((w) => w.trim().toLowerCase()).filter(Boolean);
  if (cleanedWanted.length === 0) return true;
  const rawJobText = jobLocations.join(' | ');
  const jobText = rawJobText.toLowerCase();
  const homeIsIndia = cleanedWanted.some((w) => INDIA_HINT.test(w));
  for (const w of cleanedWanted) {
    if (w === 'remote' || w === 'anywhere' || w === 'work from home') {
      if (jobIsRemote || isRemoteText(jobText)) {
        if (!homeIsIndia || INDIA_HINT.test(jobText) || /anywhere|global|worldwide/.test(jobText)) return true;
        // A remote job restricted to another country is not useful from India ("Austin, TX - Remote")
        const foreign = FOREIGN_COUNTRY.test(jobText) || FOREIGN_CITY.test(jobText) || US_STATE_CODE.test(rawJobText);
        if (!foreign) return true;
      }
      continue;
    }
    if (w === 'india') {
      if (INDIA_HINT.test(jobText)) return true;
      continue;
    }
    const city = w.split(',')[0].trim();
    const aliases = CITY_ALIASES[city] || [city];
    if (aliases.some((a) => a.length > 1 && jobText.includes(a))) return true;
  }
  return false;
}

export function workModeFromText(text: string): 'Remote' | 'Hybrid' | 'Onsite' | 'Flexible' {
  const t = text.toLowerCase();
  if (/\bhybrid\b/.test(t)) return 'Hybrid';
  if (isRemoteText(t)) return 'Remote';
  if (/on-?site|in office|work from office|\bwfo\b/.test(t)) return 'Onsite';
  // Unknown: eligibility treats Flexible as compatible with any work-mode preference
  return 'Flexible';
}

export function daysAgo(iso?: string | number): number {
  if (!iso) return 0;
  const t = typeof iso === 'number' ? iso : Date.parse(iso);
  if (Number.isNaN(t)) return 0;
  return (Date.now() - t) / (24 * 3600 * 1000);
}

/** Parses "2 days ago", "Just now", "30+ days ago", "1 week ago" into an ISO date. */
export function relativeDateToIso(text: string): string | undefined {
  const t = (text || '').toLowerCase();
  if (!t) return undefined;
  if (/just now|today|few hours|hour|minute/.test(t)) return new Date().toISOString();
  const m = t.match(/(\d+)\+?\s*(day|week|month)/);
  if (!m) return undefined;
  const n = parseInt(m[1], 10) * (m[2] === 'week' ? 7 : m[2] === 'month' ? 30 : 1);
  return new Date(Date.now() - n * 24 * 3600 * 1000).toISOString();
}
