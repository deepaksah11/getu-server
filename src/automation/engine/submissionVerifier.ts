import { Page } from 'playwright';
import { detectChallenge } from './challengeDetector.js';
import { bodyText, firstVisible, sleep } from './pageUtils.js';

export interface VerifyOptions {
  successSelectors?: string[];
  successText?: RegExp;
  successUrl?: RegExp;
  errorSelectors?: string[];
  timeoutMs?: number;
}

export interface VerifyResult {
  outcome: 'success' | 'error' | 'challenge' | 'unknown';
  message: string;
  confirmationNumber?: string;
  errors?: string[];
}

const GENERIC_SUCCESS =
  /thank(s| you)( so much)? for (applying|your (application|interest|submission))|application (has been |was )?(successfully )?(submitted|received|sent|completed)|successfully (applied|submitted)|we('ve| have) received your application|your application (is on its way|has been sent|was sent)|applied successfully|you('ve| have) (successfully )?applied/i;

const GENERIC_SUCCESS_URL = /\/(thanks|thank-you|thankyou|confirmation|success|submitted|applied)(\b|\/|\?|$)/i;

const GENERIC_ERRORS = [
  '[aria-invalid="true"]',
  '.artdeco-inline-feedback--error',
  '[class*="error-message" i]',
  '[class*="field-error" i]',
  '[class*="errorMessage" i]',
  '[role="alert"]',
];

/** Extracts a confirmation/reference number only when the page actually shows one. */
export function extractConfirmationNumber(text: string): string | undefined {
  const match = text.match(/(?:confirmation|reference|application|tracking)\s*(?:number|no\.?|id|code|#)\s*(?:is)?\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{4,30})/i);
  return match?.[1];
}

/**
 * Watches the page after clicking submit. Success requires an explicit signal
 * (confirmation text, element or URL); silence is reported as 'unknown' so the
 * application is never marked submitted on a guess.
 */
export async function verifySubmission(page: Page, options: VerifyOptions = {}): Promise<VerifyResult> {
  const timeout = options.timeoutMs ?? 15000;
  const deadline = Date.now() + timeout;
  let errorSeenAt = 0;

  while (Date.now() < deadline) {
    await sleep(600);
    if (page.isClosed()) {
      return { outcome: 'unknown', message: 'The application window closed before a confirmation appeared.' };
    }

    const challenge = await detectChallenge(page);
    if (challenge.requiresHumanAction) {
      return { outcome: 'challenge', message: challenge.reason || 'Human verification required' };
    }

    const text = await bodyText(page);
    const url = page.url();
    const successBySelector = options.successSelectors?.length ? await firstVisible(page, options.successSelectors) : null;
    if (
      successBySelector ||
      (options.successText && options.successText.test(text)) ||
      (options.successUrl && options.successUrl.test(url)) ||
      GENERIC_SUCCESS.test(text) ||
      GENERIC_SUCCESS_URL.test(new URL(url).pathname)
    ) {
      return { outcome: 'success', message: 'The platform confirmed the application.', confirmationNumber: extractConfirmationNumber(text) };
    }

    const errorTexts = await page
      .evaluate((selectors: string[]) => {
        const out: string[] = [];
        for (const sel of selectors) {
          for (const el of Array.from(document.querySelectorAll(sel))) {
            const rect = (el as HTMLElement).getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;
            const t = ((el as HTMLElement).innerText || '').replace(/\s+/g, ' ').trim();
            if (sel === '[aria-invalid="true"]') {
              const id = el.getAttribute('id');
              const label = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
              out.push(((label as HTMLElement)?.innerText || el.getAttribute('aria-label') || el.getAttribute('name') || 'field').trim());
            } else if (t && t.length < 300 && /required|invalid|please|must|error|enter|select|missing/i.test(t)) {
              out.push(t);
            }
          }
        }
        return Array.from(new Set(out)).slice(0, 10);
      }, [...(options.errorSelectors || []), ...GENERIC_ERRORS])
      .catch(() => [] as string[]);

    if (errorTexts.length > 0) {
      if (!errorSeenAt) errorSeenAt = Date.now();
      // Give asynchronous submissions a moment; persistent errors mean the form was rejected
      if (Date.now() - errorSeenAt > 2500) {
        return { outcome: 'error', message: `The form reported problems: ${errorTexts.join('; ')}`, errors: errorTexts };
      }
    } else {
      errorSeenAt = 0;
    }
  }
  return { outcome: 'unknown', message: 'No confirmation was shown after submitting.' };
}
