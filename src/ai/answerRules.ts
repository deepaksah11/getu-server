import { CandidateProfile, CandidateSkill } from '../types/index.js';
import { extractSkillsFromText, skillsEquivalent } from './skillDictionary.js';

export type FieldKind =
  | 'text'
  | 'textarea'
  | 'number'
  | 'email'
  | 'tel'
  | 'url'
  | 'date'
  | 'select'
  | 'radio'
  | 'checkbox'
  | 'checkbox-group'
  | 'combobox'
  | 'file';

export interface QuestionContext {
  question: string;
  kind?: FieldKind;
  options?: string[];
  required?: boolean;
  job?: { title: string; company: string; platform: string; skills?: string[]; locations?: string[] };
}

export interface RuleAnswer {
  answer: string;
  source: 'candidate_profile' | 'rule';
  confidence: number;
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

export function normalizeQuestion(text: string): string {
  return text
    .toLowerCase()
    .replace(/\*/g, ' ')
    .replace(/\(required\)|\(optional\)/g, ' ')
    .replace(/[^a-z0-9+#.%/ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function norm(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9+#.% ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const YES_WORDS = ['yes', 'y', 'true', 'i do', 'i am', 'i have', 'agree', 'i agree', 'accept', 'i consent'];
const NO_WORDS = ['no', 'n', 'false', 'i do not', "i don't", 'i am not', 'i have not', 'disagree', 'decline'];

/** Parses money-like strings ("12 LPA", "₹12,00,000", "$165k", "1.2 Cr") into a number. */
export function parseAmount(value?: string): number | null {
  if (!value) return null;
  const lower = value.toLowerCase().replace(/,/g, '');
  const match = lower.match(/(\d+(?:\.\d+)?)/);
  if (!match) return null;
  let amount = parseFloat(match[1]);
  if (/\b(lpa|lakh|lakhs|lac|l)\b/.test(lower)) amount *= 100000;
  else if (/\b(cr|crore|crores)\b/.test(lower)) amount *= 10000000;
  else if (/\d\s*k\b/.test(lower)) amount *= 1000;
  else if (/\d\s*(m|mn|million)\b/.test(lower)) amount *= 1000000;
  return Math.round(amount);
}

function formatYears(years: number): string {
  const rounded = Math.round(years * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function yesNo(value: boolean | undefined): string | null {
  if (value === undefined || value === null) return null;
  return value ? 'Yes' : 'No';
}

function firstName(p: CandidateProfile): string {
  return (p.full_name || '').trim().split(/\s+/)[0] || '';
}

function lastName(p: CandidateProfile): string {
  const parts = (p.full_name || '').trim().split(/\s+/);
  return parts.length > 1 ? parts.slice(1).join(' ') : '';
}

function locationParts(p: CandidateProfile): { city: string; state: string; country: string } {
  const parts = (p.location || '')
    .replace(/\(.*?\)/g, '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const city = parts[0] || '';
  const country = parts.length >= 2 ? parts[parts.length - 1] : '';
  const state = parts.length >= 3 ? parts[1] : '';
  return { city, state, country: normalizeCountry(country, p) };
}

const INDIAN_STATES_OR_CITIES =
  /\b(india|bengaluru|bangalore|mumbai|delhi|new delhi|noida|gurgaon|gurugram|hyderabad|pune|chennai|kolkata|ahmedabad|jaipur|lucknow|indore|bhopal|chandigarh|kochi|coimbatore|nagpur|patna|karnataka|maharashtra|telangana|tamil nadu|uttar pradesh|west bengal|gujarat|rajasthan|kerala|haryana|bihar|odisha|madhya pradesh)\b/i;

function normalizeCountry(country: string, p: CandidateProfile): string {
  if (country && country.length > 2 && !/^[A-Z]{2}$/.test(country)) return country;
  if (INDIAN_STATES_OR_CITIES.test(p.location || '') || /^\+?91/.test((p.phone || '').replace(/\D/g, ''))) {
    return 'India';
  }
  if (/^[A-Z]{2}$/.test(country)) return 'United States';
  return country;
}

function phoneDigits(p: CandidateProfile): { full: string; national: string; countryCode: string } {
  const raw = (p.phone || '').trim();
  const digits = raw.replace(/\D/g, '');
  if (raw.startsWith('+')) {
    if (digits.startsWith('91') && digits.length === 12) {
      return { full: raw, national: digits.slice(2), countryCode: '+91' };
    }
    if (digits.startsWith('1') && digits.length === 11) {
      return { full: raw, national: digits.slice(1), countryCode: '+1' };
    }
    if (digits.startsWith('44') && digits.length >= 11) {
      return { full: raw, national: digits.slice(2), countryCode: '+44' };
    }
  }
  if (digits.length === 10) {
    const india = normalizeCountry('', p) === 'India';
    return { full: raw, national: digits, countryCode: india ? '+91' : '' };
  }
  return { full: raw, national: digits, countryCode: '' };
}

function currentJob(p: CandidateProfile) {
  return p.experience.find((e) => e.is_current) || p.experience[0];
}

function highestEducation(p: CandidateProfile) {
  return [...p.education].sort((a, b) => (b.end_year || 0) - (a.end_year || 0))[0];
}

function findSkill(p: CandidateProfile, name: string): CandidateSkill | undefined {
  return p.skills.find((s) => skillsEquivalent(s.name, name));
}

/** Skills named in the question text, using the candidate's skills and the job's skills as extra vocabulary. */
function skillsInQuestion(q: string, p: CandidateProfile, jobSkills: string[] = []): string[] {
  return extractSkillsFromText(q, [...p.skills.map((s) => s.name), ...jobSkills]);
}

function noticeDays(p: CandidateProfile): number | null {
  return Number.isFinite(p.notice_period_days) ? p.notice_period_days : null;
}

/** 0 = unknown, 0.5 = diploma, 1 = bachelor, 2 = master, 3 = doctorate */
function degreeLevel(degree: string): number {
  const d = (degree || '').toLowerCase();
  if (/ph\.?\s?d|doctor/.test(d)) return 3;
  if (/master|\bm\.?\s?(tech|s|sc|e|a|com|phil)\b|\bmba\b|\bmca\b|post.?graduate|\bpgdm\b/.test(d)) return 2;
  if (/bachelor|\bb\.?\s?(tech|s|sc|e|a|com|arch|pharm)\b|\bbca\b|\bbba\b|\bbs\b|\bba\b|undergraduate|graduat/.test(d)) return 1;
  if (/diploma|associate/.test(d)) return 0.5;
  return 0;
}

/** Maps a degree such as "B.E." to an option like "Bachelor's Degree". */
function degreeOption(options: string[], degree: string): string | null {
  const level = degreeLevel(degree);
  const patterns: Record<number, RegExp> = {
    3: /ph\.?\s?d|doctor/i,
    2: /master|post.?grad|m\.?\s?tech|\bmba\b|\bmca\b|\bm\.?\s?sc?\b/i,
    1: /bachelor|under.?grad|b\.?\s?tech|\bb\.?\s?e\b|\bb\.?\s?sc\b|\bbca\b|\bbba\b|^graduate|\bgraduate degree/i,
    0.5: /diploma|associate/i,
  };
  const pattern = patterns[level];
  if (!pattern) return null;
  return options.find((o) => pattern.test(o) && !(level === 1 && /post.?grad|master/i.test(o))) || null;
}

function startDateFromNotice(days: number): string {
  const d = new Date(Date.now() + Math.max(0, days) * 24 * 3600 * 1000);
  return d.toISOString().split('T')[0];
}

// ---------------------------------------------------------------------------
// Option matching
// ---------------------------------------------------------------------------

function isYes(text: string): boolean {
  const n = norm(text);
  return YES_WORDS.some((w) => n === w || n.startsWith(`${w} `)) || /^yes\b/.test(n);
}

function isNo(text: string): boolean {
  const n = norm(text);
  return NO_WORDS.some((w) => n === w || n.startsWith(`${w} `)) || /^no\b/.test(n);
}

function isDeclineOption(text: string): boolean {
  return /prefer not|decline|don.?t wish|do not wish|not to (say|answer|disclose)|rather not|choose not/i.test(text);
}

function rangeContains(option: string, value: number): boolean {
  const n = option.toLowerCase().replace(/,/g, '');
  const between = n.match(/(\d+(?:\.\d+)?)\s*(?:-|–|to)\s*(\d+(?:\.\d+)?)/);
  if (between) return value >= parseFloat(between[1]) && value <= parseFloat(between[2]);
  const plus = n.match(/(\d+(?:\.\d+)?)\s*\+|(?:more than|over|above|at least|minimum)\s*(\d+(?:\.\d+)?)/);
  if (plus) return value >= parseFloat(plus[1] || plus[2]);
  const less = n.match(/(?:less than|under|below|up to|upto|<)\s*(\d+(?:\.\d+)?)/);
  if (less) return value < parseFloat(less[1]) || (/up ?to/.test(n) && value <= parseFloat(less[1]));
  const single = n.match(/^(\d+(?:\.\d+)?)\b/);
  if (single) return Math.round(value) === Math.round(parseFloat(single[1]));
  return false;
}

/**
 * Picks the option that best represents the desired answer. Handles yes/no
 * synonyms, numeric ranges ("3-5 years"), and fuzzy text containment.
 */
export function pickOption(options: string[], desired: string): string | null {
  const usable = options.filter((o) => o && !/^(select|choose|please select|--|none selected)\b/i.test(o.trim()));
  if (usable.length === 0 || !desired) return null;
  const d = norm(desired);

  const exact = usable.find((o) => norm(o) === d);
  if (exact) return exact;

  if (isYes(desired)) {
    const yes = usable.find((o) => isYes(o));
    if (yes) return yes;
  }
  if (isNo(desired)) {
    const no = usable.find((o) => isNo(o));
    if (no) return no;
  }

  const numeric = parseFloat(d.replace(/[^0-9.]/g, ''));
  if (/^\d/.test(d) && !Number.isNaN(numeric)) {
    const ranged = usable.find((o) => rangeContains(o, numeric));
    if (ranged) return ranged;
  }

  // Whole-word matches before substrings: "India" must pick "India +91", not "British Indian Ocean Territory"
  const escaped = d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const startsWithWord = usable.find((o) => new RegExp(`^${escaped}(\\b|\\s|$)`).test(norm(o)));
  if (startsWithWord) return startsWithWord;
  const wholeWord = usable.find((o) => new RegExp(`(^|\\s)${escaped}(\\s|$)`).test(norm(o)));
  if (wholeWord) return wholeWord;
  const optionInDesired = usable.find((o) => norm(o).length > 2 && new RegExp(`(^|\\s)${norm(o).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`).test(d));
  if (optionInDesired) return optionInDesired;
  const contains = usable.find((o) => norm(o).includes(d) || (norm(o).length > 2 && d.includes(norm(o))));
  if (contains) return contains;

  // Token overlap as a last resort
  const dTokens = new Set(d.split(' ').filter((t) => t.length > 2));
  let best: { option: string; score: number } | null = null;
  for (const o of usable) {
    const tokens = norm(o).split(' ').filter((t) => t.length > 2);
    if (tokens.length === 0) continue;
    const overlap = tokens.filter((t) => dTokens.has(t)).length / Math.max(tokens.length, dTokens.size);
    if (overlap > 0.5 && (!best || overlap > best.score)) best = { option: o, score: overlap };
  }
  return best?.option || null;
}

function noticeOption(options: string[], days: number): string | null {
  const usable = options.filter((o) => !/^(select|choose)/i.test(o));
  if (days <= 0) {
    const immediate = usable.find((o) => /immediate|now|0 days|serving|available/i.test(o));
    if (immediate) return immediate;
  }
  let best: { option: string; diff: number } | null = null;
  for (const o of usable) {
    const n = o.toLowerCase();
    const num = parseFloat(n.replace(/[^0-9.]/g, ''));
    if (Number.isNaN(num)) {
      if (/immediate/.test(n) && days <= 7) return o;
      continue;
    }
    let optDays = num;
    if (/month/.test(n)) optDays = num * 30;
    else if (/week/.test(n)) optDays = num * 7;
    const lessOrEqual = /less|within|or less|up ?to|max/.test(n);
    if (lessOrEqual && days <= optDays) {
      const diff = optDays - days;
      if (!best || diff < best.diff) best = { option: o, diff };
      continue;
    }
    const diff = Math.abs(optDays - days);
    if (!best || diff < best.diff) best = { option: o, diff };
  }
  return best?.option || null;
}

const PROFICIENCY_ORDER = ['beginner', 'basic', 'elementary', 'intermediate', 'proficient', 'advanced', 'expert'];

function proficiencyOption(options: string[], level?: string): string | null {
  if (!level) {
    return options.find((o) => /none|no experience|never|beginner|basic/i.test(o)) || null;
  }
  const direct = pickOption(options, level);
  if (direct) return direct;
  const target = PROFICIENCY_ORDER.indexOf(level.toLowerCase());
  let best: { option: string; diff: number } | null = null;
  for (const o of options) {
    const idx = PROFICIENCY_ORDER.findIndex((p) => o.toLowerCase().includes(p));
    if (idx < 0) continue;
    const diff = Math.abs(idx - target);
    if (!best || diff < best.diff) best = { option: o, diff };
  }
  return best?.option || null;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

function wrap(answer: string | null | undefined, confidence = 0.95, source: RuleAnswer['source'] = 'candidate_profile'): RuleAnswer | null {
  if (answer === null || answer === undefined) return null;
  const trimmed = String(answer).trim();
  if (!trimmed) return null;
  return { answer: trimmed, source, confidence };
}

/**
 * Answers a form question strictly from the candidate profile. Returns null when
 * the profile does not contain the fact, so the caller can ask the AI (grounded)
 * or record the question for the user instead of guessing.
 */
export function answerFromProfile(ctx: QuestionContext, p: CandidateProfile): RuleAnswer | null {
  const raw = ctx.question || '';
  const q = normalizeQuestion(raw);
  if (!q) return null;
  const kind = ctx.kind || 'text';
  const options = ctx.options || [];
  const hasOptions = options.length > 0;
  const numeric = kind === 'number';
  const yesNoQuestion =
    hasOptions && options.some((o) => isYes(o)) && options.some((o) => isNo(o));
  const choose = (desired: string | null): RuleAnswer | null => {
    if (desired === null) return null;
    if (!hasOptions) return wrap(desired);
    const picked = pickOption(options, desired);
    return picked ? wrap(picked) : null;
  };

  // Yes/no questions with a numeric threshold: "Do you have 3+ years of Java?", "Can you join within 30 days?"
  if (yesNoQuestion || kind === 'checkbox') {
    const threshold = q.match(/(\d+(?:\.\d+)?)\s*\+?\s*(years?|yrs|months?|weeks?|days?)/);
    if (threshold) {
      const value = parseFloat(threshold[1]);
      const unit = threshold[2];
      // "Can you join within 15 days?" / "notice period under 2 months?" — not "a 6-month internship starting in Jan"
      if (/(join|start)\w*\s+(within|in|after|by)\s+\d|\bnotice\b/.test(q) && noticeDays(p) !== null) {
        const limitDays = /month/.test(unit) ? value * 30 : /week/.test(unit) ? value * 7 : /year/.test(unit) ? value * 365 : value;
        return choose(noticeDays(p)! <= limitDays ? 'Yes' : 'No');
      }
      if (/experience|worked|working/.test(q) && /year|yr/.test(unit)) {
        const mentioned = skillsInQuestion(raw, p, ctx.job?.skills);
        const owned = mentioned.map((m) => findSkill(p, m)).filter(Boolean) as CandidateSkill[];
        const years =
          mentioned.length > 0
            ? owned.length > 0 ? Math.max(...owned.map((s) => s.years_experience || 0)) : 0
            : p.years_of_experience || 0;
        return choose(years >= value ? 'Yes' : 'No');
      }
    }
    if (/serving (your )?notice/.test(q)) return null;
    // Only "do you hold a degree" questions; availability questions that merely mention graduates are not about this
    if (
      /\b(bachelor|master|degree|graduate|diploma|ph\.?d|doctorate)\b/.test(q) &&
      /(do you (have|hold|possess)|have you (completed|earned|obtained|graduated)|are you a (graduate|post.?graduate)|degree (holder|completed))/.test(q)
    ) {
      const level = /ph\.?d|doctor/.test(q) ? 3 : /master|post.?graduate|\bmba\b|\bmca\b/.test(q) ? 2 : 1;
      const held = Math.max(0, ...p.education.map((e) => degreeLevel(e.degree)));
      if (held === 0 && p.education.length === 0) return null;
      return choose(held >= level ? 'Yes' : 'No');
    }
  }

  // --- Identity -----------------------------------------------------------
  if (yesNoQuestion) {
    // Identity and contact rules below return free-text facts; they never answer yes/no questions
  } else if (/\b(first|given) name\b/.test(q)) return wrap(firstName(p));
  if (!yesNoQuestion && /\b(last|family) name\b|\bsurname\b/.test(q)) return wrap(lastName(p) || firstName(p));
  if (/\bmiddle name\b/.test(q)) return null;
  if (!yesNoQuestion && /\bpreferred (first )?name\b|\bnick ?name\b|name you.d prefer|what should we call you/.test(q)) return wrap(firstName(p));
  if (!yesNoQuestion && /\b(full|legal|candidate|applicant|your) name\b|^name$|^name /.test(q)) return wrap(p.full_name);

  // --- Contact --------------------------------------------------------------
  if (yesNoQuestion) {
    // skip contact facts for yes/no questions
  } else if (/\b(country|dialing|phone) code\b/.test(q) && !/\b(number|without|with)\b/.test(q)) {
    const cc = phoneDigits(p).countryCode;
    if (!cc) return null;
    if (!hasOptions) return wrap(cc);
    const country = locationParts(p).country;
    const picked =
      options.find((o) => o.includes(cc) && country && o.toLowerCase().includes(country.toLowerCase())) ||
      options.find((o) => o.replace(/\s/g, '').includes(cc)) ||
      (country ? pickOption(options, country) : null);
    return picked ? wrap(picked) : null;
  } else if (/e ?mail/.test(q) && !/\b(alert|newsletter|marketing|updates|opt)\b/.test(q)) {
    return wrap(p.email);
  } else if (/\b(phone|mobile|contact number|cell|whatsapp|telephone)\b/.test(q)) {
    const ph = phoneDigits(p);
    if (/without country code|10 digit|10-digit/.test(q) || kind === 'number') return wrap(ph.national);
    return wrap(p.phone);
  }

  // --- Links ----------------------------------------------------------------
  if (!yesNoQuestion) {
    if (/linked ?in/.test(q)) return wrap(p.linkedin_url);
    if (/git ?hub|gitlab|bitbucket/.test(q)) return wrap(p.github_url);
    if (/portfolio|personal (website|site|page)|^website\b|\bwebsite url\b|\bblog\b/.test(q)) {
      // GitHub/LinkedIn stand in for a portfolio only when the field is mandatory
      return wrap(p.portfolio_url || (ctx.required ? p.github_url || p.linkedin_url : undefined));
    }
    if (/twitter|x\.com|instagram|facebook/.test(q)) return null;
  }

  // --- Location -------------------------------------------------------------
  const loc = locationParts(p);
  if (/\brelocat/.test(q)) {
    return choose(yesNo(p.willing_to_relocate));
  }
  if (/\b(zip|postal|pin) ?code\b|\bpincode\b/.test(q)) return null;
  // Location facts answer "which country/city" questions, never yes/no ones like "authorized to work in this country?"
  if (!yesNoQuestion && kind !== 'checkbox') {
    if (/\bcountry\b/.test(q) && !/countries|this country|the country/.test(q)) {
      if (/\b(citizen|nationality)\b/.test(q)) return null;
      return choose(loc.country || null);
    }
    if (/^(state|province|region)\b|\b(your|current|home|which) (state|province)\b|state of residence|state\/province/.test(q)) {
      return loc.state ? choose(loc.state) : null;
    }
    if (/\b(current|present|preferred)? ?(city|location)\b|where (are you|do you) (currently )?(located|based|live)|\baddress\b/.test(q)
      && !/preferred location|job location|willing|comfortable/.test(q)) {
      if (/\bcity\b/.test(q)) return choose(loc.city || p.location);
      return choose(p.location || null);
    }
    if (/preferred (work )?location/.test(q)) return choose(p.preferred_locations[0] || p.location || null);
  }

  // --- Notice period & availability ------------------------------------------
  const notice = Number.isFinite(p.notice_period_days) ? p.notice_period_days : null;
  if (/notice period|how soon can you (join|start)|when can you (join|start)|earliest (start|joining)|joining time|availability to (join|start)|available to (join|start)|serving notice/.test(q)) {
    if (notice === null) return null;
    if (kind === 'date') return wrap(startDateFromNotice(notice));
    if (hasOptions) return noticeOption(options, notice) ? wrap(noticeOption(options, notice)!) : null;
    if (numeric) return wrap(/month/.test(q) ? String(Math.round(notice / 30)) : String(notice));
    return wrap(notice === 0 ? 'Immediately' : /month/.test(q) ? `${Math.round(notice / 30)} months` : `${notice} days`);
  }
  if (/\b(start|joining) date\b|date (you are|you.re) available/.test(q)) {
    if (notice === null) return null;
    return wrap(startDateFromNotice(notice));
  }

  // --- Compensation --------------------------------------------------------
  if (/\b(current|present|last drawn)\b.*\b(ctc|salary|compensation|package|pay)\b|\bcurrent annual\b/.test(q)) {
    const value = p.current_ctc;
    if (!value) return null;
    if (numeric) {
      const amount = parseAmount(value);
      return amount !== null ? wrap(/lakh|lpa/.test(q) ? formatYears(amount / 100000) : String(amount)) : null;
    }
    return choose(value);
  }
  if (/\b(expected|desired|target)\b.*\b(ctc|salary|compensation|package|pay)\b|salary expectation|expected package|compensation expectation/.test(q)) {
    const value = p.salary_expectation;
    if (!value || /^(open|negotiable)$/i.test(value.trim())) {
      return numeric ? null : wrap(value || null);
    }
    if (numeric) {
      const amount = parseAmount(value);
      return amount !== null ? wrap(/lakh|lpa/.test(q) ? formatYears(amount / 100000) : String(amount)) : null;
    }
    return choose(value);
  }

  // --- Experience ------------------------------------------------------------
  if (/(years|yrs)\b.*\bexperience|experience\b.*\b(years|yrs)|how many years|how long have you/.test(q)) {
    const mentioned = skillsInQuestion(raw, p, ctx.job?.skills).filter(
      (s) => !/^(experience|years)$/i.test(s)
    );
    let years: number;
    if (mentioned.length > 0) {
      const owned = mentioned.map((m) => findSkill(p, m)).filter(Boolean) as CandidateSkill[];
      years = owned.length > 0 ? Math.max(...owned.map((s) => s.years_experience || 0)) : 0;
    } else {
      years = p.years_of_experience || 0;
    }
    // Whole years (rounded down, never overstated): most forms reject decimals here
    const value = String(Math.floor(years));
    if (hasOptions) {
      const picked = pickOption(options, value);
      return picked ? wrap(picked) : null;
    }
    return wrap(value);
  }

  // --- Work authorisation ------------------------------------------------------
  // The profile's authorization applies to the candidate's own country; a job abroad needs a visa
  const foreignJob = jobIsAbroad(ctx.job?.locations || [], p) || mentionsForeignPlace(raw, p);
  if (/sponsor|visa|work permit|h-?1b/.test(q)) {
    if (/require|need|will you|support/.test(q) || yesNoQuestion) {
      return choose(yesNo(foreignJob ? true : p.requires_sponsorship ?? false));
    }
  }
  if (/(authori[sz]ed|eligible|legally (able|allowed|permitted)|right) to work|work authori[sz]ation/.test(q)) {
    return choose(yesNo(foreignJob ? false : p.work_authorized ?? true));
  }

  // --- Demographic (EEO) -------------------------------------------------------
  if (/\bgender\b|\bsex\b/.test(q)) {
    if (p.gender) return choose(p.gender);
    const decline = options.find(isDeclineOption);
    return decline ? wrap(decline, 0.9) : null;
  }
  if (/\brace\b|ethnic|hispanic|latino|veteran|disabilit|sexual orientation|pronoun|transgender|lgbt/.test(q)) {
    const decline = options.find(isDeclineOption);
    if (decline) return wrap(decline, 0.9);
    return hasOptions ? null : wrap('Prefer not to say', 0.7);
  }
  if (/date of birth|\bdob\b|birth ?date|\bage\b/.test(q) && !/18|eighteen|legal age/.test(q)) return null;

  // --- Common compliance questions ----------------------------------------------
  if (/(18|eighteen) years|legal (working )?age|age of majority|over the age/.test(q)) return choose('Yes');
  if (/background (check|verification|screening)|drug (test|screen)/.test(q)) return choose('Yes');
  if (/\b(relative|related to|family member)\b/.test(q)) return choose('No');
  if (/(previously|ever|formerly|before) (worked|been employed|employed|interned|consulted)|current or former employee|former employee|worked (here|for us)/.test(q)) {
    const company = ctx.job?.company?.toLowerCase();
    const worked = company ? p.experience.some((e) => e.company.toLowerCase().includes(company)) : false;
    return choose(worked ? 'Yes' : 'No');
  }
  if (/non.?compete|post.?employment restriction|employment agreement/.test(q)) return choose('No');
  if (/(text message|sms|marketing|newsletter|promotional|job alerts)/.test(q) && (hasOptions || kind === 'checkbox')) {
    if (kind === 'checkbox') return ctx.required ? wrap('Yes', 0.8, 'rule') : null;
    const no = options.find((o) => isNo(o) || /do not|don.?t/i.test(o));
    return no ? wrap(no, 0.85, 'rule') : null;
  }
  // Legal waivers are the user's decision: they are asked once through the answer bank
  if (/arbitration|waive|waiver|class action|non.?disparagement/.test(q)) return null;
  const consentWording = /\b(agree|consent|acknowledge|accept|certify|attest|confirm that|understand)\b|privacy (policy|notice)|terms (and|&) conditions/.test(q);
  // Yes/no consent only for policy/data/accuracy statements, never for preferences like "agree to night shifts"
  const policyStatement = /privacy|terms|policy|personal (data|information)|processing|gdpr|retention|information (provided|submitted)|true(,)? (and|&) (correct|complete|accurate)|accurate/.test(q);
  if (consentWording && (kind === 'checkbox' || (yesNoQuestion && policyStatement))) {
    if (!hasOptions) return wrap('Yes', 0.9, 'rule');
    const yes = options.find((o) => isYes(o) || /agree|accept|acknowledge|consent/i.test(o));
    return yes ? wrap(yes, 0.9, 'rule') : null;
  }

  // --- Referral / source -----------------------------------------------------------
  if (/refer(red)? by|referral (name|code)|employee referral|who referred/.test(q)) {
    return hasOptions ? choose('No') : null;
  }
  if (/how did you (hear|find|learn|come across)|where did you (hear|find|see)|source of (application|hire)/.test(q)) {
    const platform = ctx.job?.platform || 'Job board';
    if (!hasOptions) return wrap(platform, 0.9, 'rule');
    const picked =
      pickOption(options, platform) ||
      options.find((o) => /job (board|site|portal)|online|internet|website/i.test(o)) ||
      options.find((o) => /other/i.test(o));
    return picked ? wrap(picked, 0.85, 'rule') : null;
  }

  // --- Education ---------------------------------------------------------------------
  const edu = highestEducation(p);
  if (/highest (level of )?(education|qualification|degree)|education level|level of education|degree (do you|you) hold|\bqualification\b/.test(q)) {
    if (!edu) return null;
    if (!hasOptions) return wrap(edu.degree);
    const byLevel = degreeOption(options, edu.degree);
    return byLevel ? wrap(byLevel) : choose(edu.degree);
  }
  if (/graduat(ion|ed)? year|year of (passing|graduation|completion)|passing (out )?year|batch/.test(q)) {
    return edu?.end_year ? choose(String(edu.end_year)) : null;
  }
  if (/\b(cgpa|gpa|percentage|grade|marks|score)\b/.test(q) && /(college|university|degree|graduation|cgpa|gpa|academic)/.test(q)) {
    return edu?.grade ? wrap(numeric ? String(parseFloat(edu.grade) || '') : edu.grade) : null;
  }
  if (/\b(university|college|institute|institution|school)\b/.test(q) && !/(high school|12th|10th|secondary)/.test(q)) {
    return edu ? choose(edu.institution) : null;
  }
  if (/field of study|\bmajor\b|speciali[sz]ation|\bstream\b|\bbranch\b|discipline/.test(q)) {
    return edu ? choose(edu.field_of_study) : null;
  }
  if (/\bdegree\b/.test(q) && !/(do you have|have you)/.test(q)) {
    return edu ? choose(edu.degree) : null;
  }

  // --- Current job -------------------------------------------------------------------
  const job = currentJob(p);
  if (/current (company|employer|organi[sz]ation)|present (company|employer)|(most recent|latest) (company|employer)|company name/.test(q)) {
    return job ? choose(job.company) : null;
  }
  if (/current (job )?(title|designation|role|position)|(most recent|latest) (title|designation|role)|job title/.test(q)) {
    return job ? choose(job.role) : null;
  }

  // --- Languages ----------------------------------------------------------------------
  if (/\blanguages?\b.*(speak|know|fluent|proficien)|(speak|fluent).*language/.test(q)) {
    if (!p.languages?.length) return null;
    if (hasOptions) return choose(p.languages[0].replace(/\s*\(.*\)/, ''));
    return wrap(p.languages.join(', '));
  }
  const langMatch = q.match(/(?:do you speak|fluent in|proficien\w* in|comfortable (?:speaking|communicating) in)\s+([a-z]+)/);
  if (langMatch && yesNoQuestion) {
    const spoken = (p.languages || []).some((l) => l.toLowerCase().includes(langMatch[1]));
    return choose(spoken ? 'Yes' : 'No');
  }

  // --- Skill proficiency / experience yes-no ----------------------------------------------
  const mentionedSkills = skillsInQuestion(raw, p, ctx.job?.skills);
  if (mentionedSkills.length > 0) {
    const owned = mentionedSkills.map((m) => findSkill(p, m)).filter(Boolean) as CandidateSkill[];
    if (/proficien|level of (expertise|experience|knowledge)|rate (your|yourself)|skill level/.test(q) && hasOptions) {
      const best = owned.sort((a, b) => PROFICIENCY_ORDER.indexOf(b.proficiency.toLowerCase()) - PROFICIENCY_ORDER.indexOf(a.proficiency.toLowerCase()))[0];
      const picked = proficiencyOption(options, best?.proficiency);
      return picked ? wrap(picked, 0.85) : null;
    }
    if (/(do you have|have you|are you (familiar|comfortable|proficient|experienced)|experience (with|in|using|on)|worked (with|on|in)|hands.?on|knowledge of|familiar with|used)/.test(q)) {
      const desired = owned.length > 0 ? 'Yes' : 'No';
      if (!hasOptions && kind !== 'text') return wrap(desired, 0.9);
      if (!hasOptions) return wrap(desired, 0.85);
      return choose(desired);
    }
  }

  // --- Free text about the candidate -----------------------------------------------------
  if ((kind === 'textarea' || kind === 'text') && /(summary|about (yourself|you)|introduce yourself|tell (us|me) about yourself|describe yourself|professional (background|profile))/.test(q)) {
    return wrap(p.professional_summary, 0.85);
  }
  if (/\bheadline\b/.test(q)) {
    return job ? wrap(`${job.role}${p.skills.length ? ` | ${p.skills.slice(0, 3).map((s) => s.name).join(', ')}` : ''}`, 0.8) : null;
  }

  // --- Work mode preferences (yes/no) --------------------------------------------------------
  if (/\bremote\b/.test(q) && (yesNoQuestion || kind === 'checkbox')) {
    return choose(/onsite only|office only/i.test(p.work_mode_preference) ? 'No' : 'Yes');
  }
  if (/commut|on.?site|in.?office|work (from|in|at) (our|the|your)?\s*([a-z]+\s){0,2}office|office location|in person|hybrid/.test(q) && (yesNoQuestion || kind === 'checkbox')) {
    const prefersRemoteOnly = /^remote( only)?$/i.test((p.work_mode_preference || '').trim());
    if (foreignJob) return choose(p.willing_to_relocate ? 'Yes' : 'No');
    // Office named in the question ("our Bangalore office") or the job's own location
    const named = q.match(/(?:our|the) ([a-z]+(?: [a-z]+)?) office/)?.[1];
    const places = [named, ...(ctx.job?.locations || [])].filter((x): x is string => Boolean(x && !/^(main|head|local|nearest|remote)$/.test(x)));
    const home = locationParts(p).city;
    if (places.length > 0 && home) {
      const local = places.some((place) => sameCity(place, home));
      return choose(local || p.willing_to_relocate ? 'Yes' : 'No');
    }
    return choose(prefersRemoteOnly && !p.willing_to_relocate ? 'No' : 'Yes');
  }

  return null;
}

const CITY_SYNONYMS: string[][] = [
  ['bengaluru', 'bangalore'],
  ['gurugram', 'gurgaon'],
  ['mumbai', 'bombay', 'navi mumbai', 'thane'],
  ['delhi', 'new delhi', 'ncr', 'noida', 'gurgaon', 'gurugram'],
  ['chennai', 'madras'],
  ['kolkata', 'calcutta'],
];

function sameCity(place: string, home: string): boolean {
  const a = place.toLowerCase();
  const b = home.toLowerCase();
  if (a.includes(b) || b.includes(a.split(',')[0].trim())) return true;
  return CITY_SYNONYMS.some((group) => group.some((g) => a.includes(g)) && group.some((g) => b.includes(g)));
}

const ABROAD = /\b(us|usa|u\.s\.|united states|americas|canada|uk|united kingdom|london|europe|emea|germany|ireland|netherlands|france|australia|singapore|japan|new york|san francisco|seattle|austin|boston|toronto|berlin|dublin|amsterdam|sydney)\b/i;
const US_STATE = /\b(AL|AK|AZ|AR|CA|CO|CT|FL|GA|IL|MA|MD|MI|MN|NC|NJ|NY|OH|OR|PA|TX|UT|VA|WA|WI|DC)\b/;
const INDIA_TEXT = /india|bengaluru|bangalore|mumbai|delhi|noida|gurgaon|gurugram|hyderabad|pune|chennai|kolkata|ahmedabad|jaipur|kochi/i;

/** A job located outside the candidate's country (currently detected for India-based candidates). */
function jobIsAbroad(jobLocations: string[], p: CandidateProfile): boolean {
  if (!INDIA_TEXT.test(p.location || '') || jobLocations.length === 0) return false;
  const text = jobLocations.join(' | ');
  if (INDIA_TEXT.test(text)) return false;
  return ABROAD.test(text) || US_STATE.test(text);
}

/** Case-sensitive on the original wording: "work for us" must not read as "US". */
function mentionsForeignPlace(rawQuestion: string, p: CandidateProfile): boolean {
  if (!INDIA_TEXT.test(p.location || '')) return false;
  return /\b(US|U\.S\.|USA|United States|UK|United Kingdom|Canada|Europe|Australia)\b/.test(rawQuestion) && !INDIA_TEXT.test(rawQuestion);
}

/** Composes a cover letter strictly from profile facts (used when no AI provider is available). */
export function composeCoverLetter(
  p: CandidateProfile,
  job: { title: string; company: string; skills?: string[] }
): string {
  const matched = p.skills
    .filter((s) => (job.skills || []).some((js) => skillsEquivalent(js, s.name)))
    .map((s) => s.name)
    .slice(0, 5);
  const strengths = (matched.length ? matched : p.skills.slice(0, 5).map((s) => s.name)).join(', ');
  const recent = currentJob(p);
  const lines = [
    `Dear Hiring Team at ${job.company},`,
    '',
    `I am applying for the ${job.title} position. ${
      recent ? `I currently work as ${recent.role} at ${recent.company}` : 'I bring hands-on experience'
    }${p.years_of_experience ? ` and have ${formatYears(p.years_of_experience)} years of professional experience` : ''}${
      strengths ? `, with strengths in ${strengths}` : ''
    }.`,
  ];
  if (p.professional_summary) {
    lines.push('', p.professional_summary);
  }
  const highlight = recent?.bullets?.[0];
  if (highlight) {
    lines.push('', `A recent example of my work: ${highlight}`);
  }
  lines.push(
    '',
    `I would welcome the opportunity to discuss how I can contribute to ${job.company}.`,
    '',
    'Sincerely,',
    p.full_name
  );
  return lines.join('\n');
}

/** Short motivation answer composed from profile facts. */
export function composeMotivation(
  p: CandidateProfile,
  job: { title: string; company: string; skills?: string[] }
): string {
  const matched = p.skills
    .filter((s) => (job.skills || []).some((js) => skillsEquivalent(js, s.name)))
    .map((s) => s.name)
    .slice(0, 4);
  const skills = matched.length ? matched.join(', ') : p.skills.slice(0, 4).map((s) => s.name).join(', ');
  const years = p.years_of_experience ? `${formatYears(p.years_of_experience)} years of experience` : 'my experience';
  return `The ${job.title} role at ${job.company} is a strong fit for ${years}${skills ? ` working with ${skills}` : ''}. ${
    p.professional_summary ? p.professional_summary.split(/(?<=\.)\s/)[0] : ''
  }`.trim();
}
