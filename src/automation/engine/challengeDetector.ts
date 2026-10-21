import { Page } from 'playwright';
import { logger } from '../../config/logger.js';

export interface ChallengeDetection {
  requiresHumanAction: boolean;
  type?: 'CAPTCHA' | 'OTP' | 'MFA' | 'SECURITY_CHECK';
  reason?: string;
}

/**
 * Detects CAPTCHA / OTP / MFA prompts that need a person. The bot never tries
 * to solve or bypass them: the application is paused for the user instead.
 *
 * Many application forms load an *invisible* reCAPTCHA/hCaptcha that only
 * scores the session; those are ignored unless an actual challenge is shown.
 */
export async function detectChallenge(page: Page): Promise<ChallengeDetection> {
  try {
    const url = page.url();
    if (/\/checkpoint\/(challenge|lg)|\/uas\/consumer-email-challenge|authwall\?.*challenge/i.test(url)) {
      return { requiresHumanAction: true, type: 'SECURITY_CHECK', reason: 'The platform asked for a security verification (checkpoint).' };
    }

    const found = await page.evaluate(() => {
      const visible = (el: Element | null): boolean => {
        if (!el) return false;
        const rect = (el as HTMLElement).getBoundingClientRect();
        const style = window.getComputedStyle(el as HTMLElement);
        return rect.width > 20 && rect.height > 20 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
      };
      const frames = Array.from(document.querySelectorAll('iframe')) as HTMLIFrameElement[];
      for (const f of frames) {
        const src = f.src || f.getAttribute('src') || '';
        if (!src) continue;
        // reCAPTCHA v2 checkbox (anchor) or the image challenge (bframe); invisible badges carry size=invisible
        if (/recaptcha\/(api2|enterprise)\/anchor/.test(src) && !/size=invisible/.test(src) && visible(f)) {
          return { type: 'CAPTCHA', reason: 'Google reCAPTCHA verification challenge detected.' };
        }
        if (/recaptcha\/(api2|enterprise)\/bframe/.test(src) && visible(f) && f.getBoundingClientRect().height > 100) {
          return { type: 'CAPTCHA', reason: 'Google reCAPTCHA image challenge detected.' };
        }
        if (/hcaptcha\.com/.test(src) && visible(f) && (/frame=checkbox/.test(src) || f.getBoundingClientRect().height > 100)) {
          return { type: 'CAPTCHA', reason: 'hCaptcha security challenge detected.' };
        }
        if (/challenges\.cloudflare\.com/.test(src) && visible(f)) {
          return { type: 'SECURITY_CHECK', reason: 'Cloudflare Turnstile verification challenge detected.' };
        }
        if (/arkoselabs|funcaptcha/.test(src) && visible(f)) {
          return { type: 'CAPTCHA', reason: 'Arkose / FunCaptcha challenge detected.' };
        }
      }
      // Widgets rendered before their iframe loads (also covers offline test pages)
      const widget = document.querySelector('.g-recaptcha:not([data-size="invisible"]), .h-captcha:not([data-size="invisible"]), .cf-turnstile');
      if (widget && visible(widget)) {
        return { type: 'CAPTCHA', reason: 'CAPTCHA verification widget detected.' };
      }

      const otpSelectors = [
        'input[autocomplete="one-time-code"]',
        'input[name*="otp" i]',
        'input[id*="otp" i]',
        'input[name*="verification_code" i]',
        'input[name*="verificationCode" i]',
        'input[id*="verification-code" i]',
        'input[name="pin"]',
        'input[name*="security_code" i]',
        'input[data-testid*="otp" i]',
      ];
      for (const sel of otpSelectors) {
        const el = document.querySelector(sel);
        if (el && visible(el)) {
          return { type: 'OTP', reason: 'A one-time password / verification code is required.' };
        }
      }

      if (/^just a moment/i.test(document.title)) {
        return { type: 'SECURITY_CHECK', reason: 'Cloudflare browser check page detected.' };
      }

      const text = (document.body?.innerText || '').slice(0, 15000);
      const patterns: [RegExp, string, string][] = [
        [/verify (that )?you('| a)re (a )?human|are you a robot|i'?m not a robot/i, 'CAPTCHA', 'Human verification prompt detected.'],
        [/enter the (\d-digit )?(code|otp) (we )?sent|we('ve| have)? sent (a|an|you a) (verification |security )?(code|otp)|enter (the )?verification code|check your (email|phone) for (a|the) code/i, 'OTP', 'The platform sent a verification code that must be entered.'],
        [/two-step verification|2-step verification|two-factor authentication|authenticator app/i, 'MFA', 'Multi-factor authentication is required.'],
        [/security verification required|let'?s do a quick security check|unusual activity/i, 'SECURITY_CHECK', 'Platform security check required.'],
        [/press and hold/i, 'SECURITY_CHECK', 'Interactive human verification challenge detected.'],
      ];
      for (const [pattern, type, reason] of patterns) {
        if (pattern.test(text)) return { type, reason };
      }
      return null;
    });

    if (found) {
      logger.warn({ type: found.type, url }, 'Human verification required on page');
      return { requiresHumanAction: true, type: found.type as ChallengeDetection['type'], reason: found.reason };
    }
    return { requiresHumanAction: false };
  } catch (err: any) {
    logger.warn({ err: err.message?.split('\n')[0] }, 'Challenge detection failed');
    return { requiresHumanAction: false };
  }
}
