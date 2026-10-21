import { AnswerBankEntry, AnswerSource, CandidateProfile, NormalizedJob } from '../../types/index.js';
import {
  answerFromProfile,
  composeMotivation,
  FieldKind,
  normalizeQuestion,
  pickOption,
} from '../../ai/answerRules.js';
import { aiService } from '../../ai/aiService.js';
import { getRepository } from '../../db/client.js';

export interface FieldQuestion {
  label: string;
  kind: FieldKind;
  options?: string[];
  required: boolean;
}

export interface GivenAnswer {
  question: string;
  answer: string;
  source: AnswerSource;
  kind: FieldKind;
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'you', 'your', 'do', 'are', 'is', 'of', 'to', 'in', 'for', 'with', 'have', 'what',
  'how', 'please', 'this', 'and', 'or', 'on', 'at', 'be', 'we', 'our', 'any', 'can', 'will', 'would', 'i',
]);

function tokens(text: string): Set<string> {
  return new Set(text.split(' ').filter((t) => t.length > 1 && !STOP_WORDS.has(t)));
}

function similarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared);
}

/**
 * Decides what to put in each form field. Order of trust:
 * 1. answers the user saved in the answer bank
 * 2. facts from the candidate profile
 * 3. AI grounded in the profile (when configured and confident)
 * Anything else is recorded as a pending question instead of being guessed.
 */
export class FormAnswerer {
  readonly given: GivenAnswer[] = [];
  readonly pending: { question: string; kind: FieldKind; options?: string[] }[] = [];

  constructor(
    private userId: string,
    private profile: CandidateProfile,
    private job: NormalizedJob,
    private bank: AnswerBankEntry[],
    private coverLetter?: string
  ) {}

  static async create(userId: string, profile: CandidateProfile, job: NormalizedJob, coverLetter?: string): Promise<FormAnswerer> {
    const bank = await getRepository().getAnswerBank(userId);
    return new FormAnswerer(userId, profile, job, bank, coverLetter);
  }

  private record(question: string, answer: string, source: AnswerSource, kind: FieldKind) {
    this.given.push({ question, answer, source, kind });
    return { answer, source };
  }

  private lookupBank(normalized: string, options: string[]): string | null {
    let best: { entry: AnswerBankEntry; score: number } | null = null;
    for (const entry of this.bank) {
      if (!entry.answer) continue;
      const score = entry.normalized === normalized ? 1 : similarity(entry.normalized, normalized);
      if (score >= 0.8 && (!best || score > best.score)) best = { entry, score };
    }
    if (!best) return null;
    if (options.length) return pickOption(options, best.entry.answer!);
    return best.entry.answer!;
  }

  async answer(q: FieldQuestion): Promise<{ answer: string; source: AnswerSource } | null> {
    const label = (q.label || '').trim();
    if (!label) return null;
    const options = (q.options || []).filter(Boolean);
    const normalized = normalizeQuestion(label);
    const jobInfo = {
      title: this.job.title,
      company: this.job.company,
      platform: this.job.platform,
      skills: this.job.skills,
      locations: this.job.locations,
    };

    const banked = this.lookupBank(normalized, options);
    if (banked) return this.record(label, banked, 'answer_bank', q.kind);

    if (/cover letter/i.test(label) && (q.kind === 'textarea' || q.kind === 'text') && this.coverLetter) {
      return this.record(label, this.coverLetter, 'rule', q.kind);
    }

    const ruled = answerFromProfile({ question: label, kind: q.kind, options, required: q.required, job: jobInfo }, this.profile);
    if (ruled) return this.record(label, ruled.answer, ruled.source, q.kind);

    const openQuestion =
      (q.kind === 'textarea' || q.kind === 'text') &&
      options.length === 0 &&
      /\bwhy\b|interest|motivat|excit|passion|what makes you|tell us|describe|explain|additional information|anything else|comments/i.test(label);

    const ai = await aiService.answerFormQuestion(
      { question: label, kind: q.kind, options, required: q.required, job: jobInfo },
      this.profile,
      this.job
    );
    if (ai) return this.record(label, ai.answer, 'ai', q.kind);

    if (openQuestion) {
      if (/additional information|anything else|comments/i.test(label)) {
        return q.required && this.coverLetter ? this.record(label, this.coverLetter, 'rule', q.kind) : null;
      }
      if (q.kind === 'textarea' || q.required) {
        return this.record(label, composeMotivation(this.profile, this.job), 'rule', q.kind);
      }
    }

    if (q.required && !this.pending.some((p) => p.question === label)) {
      this.pending.push({ question: label, kind: q.kind, options: options.length ? options : undefined });
    }
    return null;
  }

  /** Marks a question as needing the user (e.g. the platform rejected our answer). */
  markPending(question: string, kind: FieldKind = 'text', options?: string[]) {
    if (question && !this.pending.some((p) => p.question === question)) {
      this.pending.push({ question, kind, options });
    }
  }

  /** Saves pending questions to the answer bank so the user can answer them once. */
  async persistPending(): Promise<void> {
    const repo = getRepository();
    for (const p of this.pending) {
      await repo.saveAnswerEntry({
        user_id: this.userId,
        question: p.question,
        normalized: normalizeQuestion(p.question),
        field_type: p.kind,
        options: p.options,
        platform: this.job.platform,
        job_id: this.job.id,
      });
    }
  }
}
