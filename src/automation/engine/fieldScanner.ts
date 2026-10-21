import { Page } from 'playwright';
import { FieldKind } from '../../ai/answerRules.js';

export interface ScannedField {
  /** value of the data-aa-id attribute stamped on the element */
  key: string;
  kind: FieldKind;
  label: string;
  required: boolean;
  options: string[];
  /** For radio / checkbox groups and yes-no button groups: data-aa-id of each option element */
  optionKeys: string[];
  value: string;
  filled: boolean;
  name?: string;
  isResume: boolean;
  isCoverLetter: boolean;
  contentEditable?: boolean;
  maxLength?: number;
  invalid?: boolean;
}

/**
 * Scans the form controls inside `scopeSelector` (or the whole page) and returns
 * one entry per question. Elements are stamped with data-aa-id so the filler can
 * target them precisely afterwards.
 */
export async function scanFields(page: Page, scopeSelector?: string | null): Promise<ScannedField[]> {
  return page.evaluate((scopeSel: string | null) => {
    const root: Element | null = scopeSel ? document.querySelector(scopeSel) : document.body;
    if (!root) return [];
    const w = window as any;
    w.__aaCounter = w.__aaCounter || 0;
    const keyOf = (el: Element): string => {
      let k = el.getAttribute('data-aa-id');
      if (!k) {
        k = `aa-${++w.__aaCounter}`;
        el.setAttribute('data-aa-id', k);
      }
      return k;
    };
    const clean = (t: string | null | undefined) => (t || '').replace(/\s+/g, ' ').trim();
    const visible = (el: Element): boolean => {
      const r = (el as HTMLElement).getBoundingClientRect();
      const s = window.getComputedStyle(el as HTMLElement);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    const textOf = (el: Element | null): string => clean(el ? (el as HTMLElement).innerText || el.textContent : '');
    // Visible label text, skipping nested controls (a <select> would add every option) and hidden status messages
    const labelTextOf = (label: Element | null): string => {
      if (!label) return '';
      const parts: string[] = [];
      const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const parent = (node as Text).parentElement;
        if (!parent || parent.closest('select, option, textarea, button, [contenteditable="true"]')) continue;
        const style = window.getComputedStyle(parent);
        if (style.display === 'none' || style.visibility === 'hidden' || parent.getClientRects().length === 0) continue;
        parts.push(node.textContent || '');
      }
      return clean(parts.join(' '));
    };
    const byIds = (ids: string): string =>
      ids
        .split(/\s+/)
        .map((id) => document.getElementById(id))
        .filter(Boolean)
        .map((e) => textOf(e))
        .join(' ');
    const controlsIn = (node: Element): Element[] =>
      Array.from(node.querySelectorAll('input:not([type=hidden]), select, textarea, [contenteditable="true"]'));

    const precedingLabelText = (el: Element): string => {
      let node: Element | null = el.parentElement;
      let depth = 0;
      while (node && node !== root.parentElement && depth < 5) {
        const others = controlsIn(node).filter((c) => {
          if (c === el || el.contains(c) || c.contains(el)) return false;
          const t = (c.getAttribute('type') || '').toLowerCase();
          const sameGroup = (t === 'radio' || t === 'checkbox') && c.getAttribute('name') && c.getAttribute('name') === el.getAttribute('name');
          return !sameGroup && t !== 'hidden' && t !== 'search';
        });
        // Container holds other questions too: stop before borrowing their labels
        if (others.length > 0) break;
        const candidates = Array.from(
          node.querySelectorAll('label, legend, [class*="label" i], [class*="question" i], [class*="title" i], h3, h4, p, span')
        ).filter((c) => !c.contains(el) && (c.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING));
        // Nearest preceding text wins
        for (let i = candidates.length - 1; i >= 0; i--) {
          const t = textOf(candidates[i]);
          if (t && t.length > 1 && t.length < 400) return t;
        }
        node = node.parentElement;
        depth++;
      }
      return '';
    };

    const labelFor = (el: Element): string => {
      let t = '';
      const labelledBy = el.getAttribute('aria-labelledby');
      if (labelledBy) t = byIds(labelledBy);
      if (!t && el.id) {
        const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (l) t = labelTextOf(l);
      }
      if (!t) {
        const l = el.closest('label');
        if (l) t = labelTextOf(l);
      }
      if (!t) t = clean(el.getAttribute('aria-label'));
      if (!t) t = precedingLabelText(el);
      if (!t) t = clean(el.getAttribute('placeholder')) || clean(el.getAttribute('name')) || clean(el.id);
      return t;
    };

    const requiredFor = (el: Element, label: string): boolean =>
      (el as HTMLInputElement).required === true ||
      el.getAttribute('aria-required') === 'true' ||
      /\*|\(required\)|✱/i.test(label);

    const results: any[] = [];
    const seenGroups = new Set<string>();

    const controls = controlsIn(root);
    for (const el of controls) {
      const tag = el.tagName.toLowerCase();
      const type = (el.getAttribute('type') || (tag === 'input' ? 'text' : tag)).toLowerCase();
      const name = el.getAttribute('name') || undefined;
      if ((el as HTMLInputElement).disabled) continue;
      if (['submit', 'button', 'reset', 'image', 'search', 'password', 'hidden'].includes(type)) continue;
      if (name && /g-recaptcha-response|h-captcha-response|honeypot|cf-turnstile/i.test(name)) continue;
      if (el.closest('[aria-hidden="true"]') && type !== 'file') continue;

      if (type === 'radio' || type === 'checkbox') {
        const groupName = name || el.closest('fieldset, [role=radiogroup], [role=group]')?.getAttribute('data-aa-group') || '';
        const group = name
          ? (Array.from(root.querySelectorAll(`input[type=${type}][name="${CSS.escape(name)}"]`)) as HTMLInputElement[])
          : [el as HTMLInputElement];
        const groupId = `${type}:${groupName || keyOf(el)}`;
        if (seenGroups.has(groupId)) continue;
        seenGroups.add(groupId);

        const optionLabels = group.map((o) => labelFor(o));
        const anyVisible = group.some((o) => visible(o) || (o.id && document.querySelector(`label[for="${CSS.escape(o.id)}"]`) && visible(document.querySelector(`label[for="${CSS.escape(o.id)}"]`)!)) || (o.closest('label') && visible(o.closest('label')!)));
        if (!anyVisible) continue;

        // Question text: fieldset legend, radiogroup label, or the text before the first option
        let question = '';
        const container = el.closest('fieldset, [role=radiogroup], [role=group]');
        if (container) {
          const legend = container.querySelector('legend');
          question =
            textOf(legend) ||
            (container.getAttribute('aria-labelledby') ? byIds(container.getAttribute('aria-labelledby')!) : '') ||
            clean(container.getAttribute('aria-label'));
        }
        if (!question) {
          let node: Element | null = el.parentElement;
          for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
            if (!group.every((g) => node!.contains(g))) continue;
            const full = textOf(node);
            let stripped = full;
            for (const ol of optionLabels) stripped = stripped.replace(ol, ' ');
            stripped = clean(stripped);
            if (stripped.length > 2) {
              question = stripped.slice(0, 300);
              break;
            }
          }
        }

        const isGroup = group.length > 1;
        const kind = type === 'radio' ? 'radio' : isGroup ? 'checkbox-group' : 'checkbox';
        const label = kind === 'checkbox' ? optionLabels[0] || question : question || optionLabels.join(' / ');
        results.push({
          key: keyOf(el),
          kind,
          label,
          required: group.some((g) => requiredFor(g, question)) || /\*/.test(question),
          options: kind === 'checkbox' ? [] : optionLabels,
          optionKeys: group.map((g) => keyOf(g)),
          value: group.filter((g) => g.checked).map((g, i) => optionLabels[group.indexOf(g)] ?? String(i)).join(', '),
          filled: group.some((g) => g.checked),
          name,
          isResume: false,
          isCoverLetter: false,
        });
        continue;
      }

      if (type === 'file') {
        const label = labelFor(el);
        const hint = `${label} ${name || ''} ${el.id} ${el.getAttribute('accept') || ''} ${textOf(el.parentElement)}`.toLowerCase();
        results.push({
          key: keyOf(el),
          kind: 'file',
          label,
          required: requiredFor(el, label),
          options: [],
          optionKeys: [],
          value: (el as HTMLInputElement).files?.length ? 'attached' : '',
          filled: Boolean((el as HTMLInputElement).files?.length),
          name,
          isResume: /resume|cv\b|curriculum/.test(hint),
          isCoverLetter: /cover/.test(hint),
        });
        continue;
      }

      if (!visible(el)) continue;
      const isEditable = el.getAttribute('contenteditable') === 'true';
      const label = labelFor(el);
      let kind: string = tag === 'select' ? 'select' : tag === 'textarea' || isEditable ? 'textarea' : type;
      if (el.getAttribute('role') === 'combobox' && tag === 'input') kind = 'combobox';
      // Numeric answers in text inputs (LinkedIn "years" fields use id="...-numeric")
      if (kind === 'text' && (/numeric/i.test(`${el.id} ${name || ''}`) || /^(numeric|decimal)$/.test(el.getAttribute('inputmode') || ''))) {
        kind = 'number';
      }
      if (!['text', 'textarea', 'number', 'email', 'tel', 'url', 'date', 'select', 'combobox'].includes(kind)) kind = 'text';

      let options: string[] = [];
      let value = '';
      let filled = false;
      if (tag === 'select') {
        const sel = el as HTMLSelectElement;
        options = Array.from(sel.options).map((o) => clean(o.text));
        const selected = sel.options[sel.selectedIndex];
        value = selected ? clean(selected.text) : '';
        filled = Boolean(sel.value) && !!selected && !/^(select|choose|please select|--)/i.test(value) && value !== '';
      } else if (isEditable) {
        value = textOf(el);
        filled = value.length > 0;
      } else {
        value = (el as HTMLInputElement).value || '';
        filled = value.trim().length > 0;
        if (kind === 'combobox' && !filled) {
          // react-select shows the chosen value in a sibling element, not in the input
          const container = el.closest('[class*="select__control"], [class*="container"], [class*="combobox"]') || el.parentElement;
          const single = container?.querySelector('[class*="single-value"], [class*="singleValue"], [class*="select__single"]');
          if (single && textOf(single)) {
            value = textOf(single);
            filled = true;
          }
        }
      }

      const maxLength = (el as HTMLInputElement).maxLength;
      results.push({
        key: keyOf(el),
        kind,
        label,
        required: requiredFor(el, label),
        options,
        optionKeys: [],
        value,
        filled,
        name,
        isResume: false,
        isCoverLetter: /cover letter/i.test(label),
        contentEditable: isEditable,
        maxLength: maxLength && maxLength > 0 ? maxLength : undefined,
        invalid: el.getAttribute('aria-invalid') === 'true',
      });
    }

    // Yes / No toggle buttons (Ashby and similar React forms)
    const buttons = Array.from(root.querySelectorAll('button')) as HTMLButtonElement[];
    for (const yes of buttons) {
      if (clean(yes.innerText).toLowerCase() !== 'yes' || !visible(yes)) continue;
      const parent = yes.parentElement;
      if (!parent) continue;
      const siblings = Array.from(parent.querySelectorAll(':scope > button')) as HTMLButtonElement[];
      const no = siblings.find((b) => clean(b.innerText).toLowerCase() === 'no');
      if (!no || siblings.length !== 2) continue;
      const groupKey = keyOf(parent);
      if (seenGroups.has(`btn:${groupKey}`)) continue;
      seenGroups.add(`btn:${groupKey}`);
      const question = precedingLabelText(parent) || labelFor(parent);
      const pressed = siblings.find(
        (b) => b.getAttribute('aria-pressed') === 'true' || /active|selected|checked/i.test(b.className)
      );
      results.push({
        key: groupKey,
        kind: 'radio',
        label: question,
        required: /\*/.test(question),
        options: ['Yes', 'No'],
        optionKeys: [keyOf(yes), keyOf(no)],
        value: pressed ? clean(pressed.innerText) : '',
        filled: Boolean(pressed),
        isResume: false,
        isCoverLetter: false,
      });
    }

    return results.map((r) => ({ ...r, label: clean(r.label).replace(/\s*\*\s*$/, '').replace(/^\*\s*/, '') }));
  }, scopeSelector ?? null);
}
