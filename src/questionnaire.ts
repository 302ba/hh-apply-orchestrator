/// <reference lib="dom" />
import type { Page } from 'playwright';

export type QuestionType = 'text' | 'textarea' | 'radio' | 'select' | 'checkbox' | 'date' | 'number';

export interface QuestionnaireQuestion {
  type: QuestionType;
  name: string;
  label: string;
  options?: string[];
  required: boolean;
}

export interface Questionnaire {
  selector: string;
  questions: QuestionnaireQuestion[];
  submitSelector: string;
}

const QUESTIONNAIRE_HINTS = [
  'для отклика необходимо ответить на несколько вопросов',
  'ответьте на несколько вопросов',
];

export function isQuestionnairePage(text: string): boolean {
  return QUESTIONNAIRE_HINTS.some((hint) => text.toLowerCase().includes(hint));
}

export async function extractQuestionnaire(page: Page): Promise<Questionnaire | undefined> {
  const form = page.locator('form').first();
  if ((await form.count()) === 0) return undefined;

  const questionHandles = await form.locator('[data-qa^="vacancy-response-form-question"]').all();
  if (questionHandles.length === 0) return undefined;

  const questions: QuestionnaireQuestion[] = [];
  for (const handle of questionHandles) {
    const dataQa = (await handle.getAttribute('data-qa')) ?? '';
    const name = dataQa.replace(/^vacancy-response-form-question-/, '').trim();
    if (!name) continue;

    const label = (
      await handle
        .locator('[data-qa^="vacancy-response-form-question__title"]')
        .first()
        .innerText()
        .catch(() => '')
    ).trim();

    const required =
      (await handle.locator('[data-qa^="vacancy-response-form-question__required"]').count()) > 0;

    if ((await handle.locator('textarea').count()) > 0) {
      questions.push({ type: 'textarea', name, label, required });
      continue;
    }

    if ((await handle.locator('select').count()) > 0) {
      const options = await handle.locator('select option').evaluateAll((opts) =>
        opts.map((o) => (o as HTMLOptionElement).value || (o as HTMLOptionElement).textContent || ''),
      );
      questions.push({ type: 'select', name, label, options, required });
      continue;
    }

    if ((await handle.locator('input[type="radio"]').count()) > 0) {
      const options = await handle
        .locator('input[type="radio"]')
        .evaluateAll((inputs) =>
          inputs.map(
            (i) => (i as HTMLInputElement).value || i.getAttribute('aria-label') || '',
          ),
        );
      questions.push({ type: 'radio', name, label, options, required });
      continue;
    }

    if ((await handle.locator('input[type="checkbox"]').count()) > 0) {
      const options = await handle
        .locator('input[type="checkbox"]')
        .evaluateAll((inputs) =>
          inputs.map(
            (i) => (i as HTMLInputElement).value || i.getAttribute('aria-label') || '',
          ),
        );
      questions.push({ type: 'checkbox', name, label, options, required });
      continue;
    }

    if ((await handle.locator('input[type="date"]').count()) > 0) {
      questions.push({ type: 'date', name, label, required });
      continue;
    }

    if ((await handle.locator('input[type="number"]').count()) > 0) {
      questions.push({ type: 'number', name, label, required });
      continue;
    }

    questions.push({ type: 'text', name, label, required });
  }

  const submitHandle = form.locator('button[type="submit"]').first();
  if ((await submitHandle.count()) === 0) return undefined;
  const submitSelector = await submitHandle.evaluate((el) => {
    let node: Element | null = el;
    while (node) {
      if (node.id) return `#${node.id}`;
      node = node.parentElement;
    }
    return 'button[type="submit"]';
  });

  return { selector: 'form', questions, submitSelector };
}

export async function fillQuestionnaire(
  page: Page,
  form: Questionnaire,
  answers: Record<string, string | string[] | undefined>,
): Promise<void> {
  for (const q of form.questions) {
    const value = answers[q.name];
    if (value === undefined || value === null) continue;
    const handle = page
      .locator(`[data-qa="vacancy-response-form-question-${q.name}"]`)
      .first();

    if (q.type === 'text' || q.type === 'number' || q.type === 'date') {
      const input = handle.locator('input').first();
      if ((await input.count()) > 0) await input.fill(String(value));
    } else if (q.type === 'textarea') {
      const ta = handle.locator('textarea').first();
      if ((await ta.count()) > 0) await ta.fill(String(value));
    } else if (q.type === 'select') {
      const select = handle.locator('select').first();
      if ((await select.count()) > 0) await select.selectOption(String(value));
    } else if (q.type === 'radio') {
      const radio = handle
        .locator(`input[type="radio"][value="${cssEscape(String(value))}"]`)
        .first();
      if ((await radio.count()) > 0) await radio.check();
    } else if (q.type === 'checkbox') {
      const values = Array.isArray(value) ? value : [String(value)];
      for (const v of values) {
        const box = handle
          .locator(`input[type="checkbox"][value="${cssEscape(String(v))}"]`)
          .first();
        if ((await box.count()) > 0) await box.check();
      }
    }
  }
}

function cssEscape(value: string): string {
  return value.replace(/(["\\])/g, '\\$1');
}
