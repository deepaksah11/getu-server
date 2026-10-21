import fs from 'fs';
import { Locator, Page } from 'playwright';
import { logger } from '../../config/logger.js';
import { FieldKind, pickOption } from '../../ai/answerRules.js';
import { FormAnswerer } from './answerEngine.js';
import { scanFields, ScannedField } from './fieldScanner.js';
import { sleep } from './pageUtils.js';

export interface FillContext {
  answerer: FormAnswerer;
  resumePath?: string;
  coverLetterPath?: string;
  /** Replace values that are already present (platform pre-fill). Default false. */
  overwrite?: boolean;
}

export interface FillReport {
  filled: { label: string; value: string; kind: FieldKind }[];
  prefilled: string[];
  unanswered: string[];
  resumeUploaded: boolean;
  fieldCount: number;
}

const isYesValue = (v: string) => /^(yes|true|y|agree|i agree|accept)\b/i.test(v.trim());

function locate(page: Page, key: string): Locator {
  return page.locator(`[data-aa-id="${key}"]`).first();
}

async function checkElement(page: Page, el: Locator): Promise<void> {
  const tag = await el.evaluate((e) => e.tagName.toLowerCase()).catch(() => 'input');
  if (tag === 'button') {
    await el.click({ timeout: 5000 });
    return;
  }
  try {
    await el.check({ timeout: 3000 });
    return;
  } catch {
    // Custom-styled inputs are often covered by their label
  }
  const id = await el.getAttribute('id').catch(() => null);
  if (id) {
    const label = page.locator(`label[for="${id.replace(/"/g, '\\"')}"]`).first();
    if (await label.isVisible().catch(() => false)) {
      await label.click({ timeout: 3000 });
      return;
    }
  }
  const wrapping = el.locator('xpath=ancestor::label[1]');
  if ((await wrapping.count()) > 0 && (await wrapping.first().isVisible().catch(() => false))) {
    await wrapping.first().click({ timeout: 3000 });
    return;
  }
  await el.evaluate((e) => (e as HTMLInputElement).click());
}

/** Options of the listbox currently open for a combobox. */
async function openListboxOptions(page: Page, combobox: Locator): Promise<string[]> {
  const controls = (await combobox.getAttribute('aria-controls').catch(() => null)) || (await combobox.getAttribute('aria-owns').catch(() => null));
  const scope = controls ? page.locator(`[id="${controls}"]`) : page;
  const options = scope.locator('[role="option"]');
  const count = await options.count().catch(() => 0);
  const texts: string[] = [];
  for (let i = 0; i < Math.min(count, 300); i++) {
    const opt = options.nth(i);
    if (await opt.isVisible().catch(() => false)) {
      const t = (await opt.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
      if (t) texts.push(t);
    }
  }
  return texts;
}

async function clickListboxOption(page: Page, combobox: Locator, text: string): Promise<boolean> {
  const controls = (await combobox.getAttribute('aria-controls').catch(() => null)) || (await combobox.getAttribute('aria-owns').catch(() => null));
  const scope = controls ? page.locator(`[id="${controls}"]`) : page;
  const options = scope.locator('[role="option"]');
  const count = await options.count().catch(() => 0);
  for (let i = 0; i < Math.min(count, 300); i++) {
    const opt = options.nth(i);
    const t = (await opt.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    if (t === text && (await opt.isVisible().catch(() => false))) {
      await opt.click({ timeout: 5000 });
      return true;
    }
  }
  return false;
}

async function fillCombobox(page: Page, field: ScannedField, ctx: FillContext): Promise<string | null> {
  const el = locate(page, field.key);
  await el.click({ timeout: 5000 }).catch(() => {});
  await sleep(400);
  let options = await openListboxOptions(page, el);

  const result = await ctx.answerer.answer({
    label: field.label,
    kind: 'combobox',
    options: options.length > 0 && options.length <= 250 ? options : undefined,
    required: field.required,
  });
  if (!result) {
    await page.keyboard.press('Escape').catch(() => {});
    return null;
  }

  let target = options.length ? pickOption(options, result.answer) : null;
  if (!target) {
    // Async search box (e.g. location autocomplete): type and choose from the suggestions
    await el.fill('').catch(() => {});
    await el.pressSequentially(result.answer.slice(0, 40), { delay: 40 }).catch(() => {});
    const deadline = Date.now() + 4000;
    do {
      await sleep(400);
      options = await openListboxOptions(page, el);
    } while (options.length === 0 && Date.now() < deadline);
    target = pickOption(options, result.answer) || options[0] || null;
  }
  if (target && (await clickListboxOption(page, el, target))) {
    return target;
  }
  await page.keyboard.press('Enter').catch(() => {});
  return result.answer;
}

async function fillOne(page: Page, field: ScannedField, ctx: FillContext): Promise<string | null> {
  if (field.kind === 'combobox') return fillCombobox(page, field, ctx);

  const result = await ctx.answerer.answer({
    label: field.label,
    kind: field.kind,
    options: field.options.length ? field.options : undefined,
    required: field.required,
  });
  if (!result) return null;
  let value = result.answer;
  const el = locate(page, field.key);
  await el.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});

  switch (field.kind) {
    case 'select': {
      const picked = pickOption(field.options, value) || field.options.find((o) => o === value);
      if (!picked) return null;
      try {
        await el.selectOption({ label: picked }, { timeout: 5000 });
      } catch {
        await el.selectOption({ index: field.options.indexOf(picked) }, { timeout: 5000 });
      }
      return picked;
    }
    case 'radio': {
      const picked = pickOption(field.options, value);
      if (!picked) return null;
      const optionKey = field.optionKeys[field.options.indexOf(picked)];
      if (!optionKey) return null;
      await checkElement(page, locate(page, optionKey));
      return picked;
    }
    case 'checkbox': {
      if (isYesValue(value)) {
        await checkElement(page, el);
        return 'Yes';
      }
      return null;
    }
    case 'checkbox-group': {
      const wanted = value.split(/[,;\n]/).map((v) => v.trim()).filter(Boolean);
      const checked: string[] = [];
      for (const w of wanted) {
        const picked = pickOption(field.options, w);
        const key = picked ? field.optionKeys[field.options.indexOf(picked)] : undefined;
        if (picked && key) {
          await checkElement(page, locate(page, key));
          checked.push(picked);
        }
      }
      return checked.length ? checked.join(', ') : null;
    }
    case 'number': {
      value = value.replace(/[^0-9.]/g, '');
      if (!value) return null;
      await el.fill(value, { timeout: 5000 });
      break;
    }
    default: {
      if (field.maxLength && value.length > field.maxLength) value = value.slice(0, field.maxLength);
      if (field.contentEditable) {
        await el.click({ timeout: 5000 });
        await page.keyboard.press('Control+A');
        await page.keyboard.press('Delete');
        await page.keyboard.insertText(value);
      } else {
        await el.fill(value, { timeout: 5000 });
      }
    }
  }
  await el.blur().catch(() => {});
  return value;
}

/**
 * Scans the scope, uploads the resume, then answers every empty field.
 * Required fields left empty are reported in `unanswered`.
 */
export async function fillForm(page: Page, scopeSelector: string | null, ctx: FillContext): Promise<FillReport> {
  const report: FillReport = { filled: [], prefilled: [], unanswered: [], resumeUploaded: false, fieldCount: 0 };
  let fields = await scanFields(page, scopeSelector);

  // Files first: several ATS forms parse the resume and pre-fill the rest of the form
  const fileFields = fields.filter((f) => f.kind === 'file');
  let uploaded = false;
  for (const f of fileFields) {
    let file: string | undefined;
    if (f.isCoverLetter) {
      file = ctx.coverLetterPath;
      if (!f.required && !file) continue;
    } else if (f.isResume || fileFields.length === 1 || !report.resumeUploaded) {
      file = ctx.resumePath;
    }
    // Already attached (e.g. on an earlier step of a multi-step form)
    if (f.filled) {
      if (!f.isCoverLetter) report.resumeUploaded = true;
      continue;
    }
    if (!file || !fs.existsSync(file)) {
      if (f.required) report.unanswered.push(f.label || 'File upload');
      continue;
    }
    try {
      await locate(page, f.key).setInputFiles(file, { timeout: 10000 });
      uploaded = true;
      if (!f.isCoverLetter) report.resumeUploaded = true;
      report.filled.push({ label: f.label || 'Resume', value: file.split(/[\\/]/).pop() || file, kind: 'file' });
    } catch (err: any) {
      logger.warn({ label: f.label, err: err.message?.split('\n')[0] }, 'File upload failed');
      if (f.required) report.unanswered.push(f.label || 'File upload');
    }
  }
  if (uploaded) {
    await sleep(2500);
    fields = await scanFields(page, scopeSelector);
  }

  const others = fields.filter((f) => f.kind !== 'file');
  report.fieldCount = others.length;
  for (const field of others) {
    if (field.filled && !(ctx.overwrite && ['text', 'email', 'tel', 'url'].includes(field.kind)) && !field.invalid) {
      report.prefilled.push(field.label);
      continue;
    }
    try {
      const value = await fillOne(page, field, ctx);
      if (value !== null) {
        report.filled.push({ label: field.label, value, kind: field.kind });
      } else if (field.required && !field.filled) {
        report.unanswered.push(field.label);
      }
    } catch (err: any) {
      logger.warn({ label: field.label, kind: field.kind, err: err.message?.split('\n')[0] }, 'Failed filling field');
      if (field.required) report.unanswered.push(field.label);
    }
  }
  return report;
}
