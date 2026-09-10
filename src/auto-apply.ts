import { chromium, type Page } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import {
  SESSION_FILE,
  getAutomationConfig,
  getLlmConfig,
  sessionExists,
  type ApplyResult,
  type Vacancy,
} from './config.js';
import {
  QUERIES_FILE,
  loadExcludedText,
  loadProfile,
  loadResume,
  loadSearchQueries,
  profileHasPlaceholders,
  PROFILE_FILE,
  type ProfileDoc,
} from './config-loader.js';
import { generateCoverLetter, answerQuestionnaire, buildProfilePrompt } from './llm.js';
import { extractQuestionnaire, fillQuestionnaire, isQuestionnairePage, type Questionnaire } from './questionnaire.js';
import { findExcludedTerm } from './exclusions.js';
import { checkLocationEligibility, parseVacancyLocation, type VacancyLocation } from './vacancy-location.js';
import { fileConsole } from './logger.js';
import { loadCachedCoverLetter, saveCoverLetter } from './letters.js';

const console = fileConsole;

interface VacancyDetails {
  description: string;
  location: VacancyLocation;
}

const HH_BASE_URL = 'https://hh.ru';

export function normalizeVacancyUrl(href: string): string {
  try {
    const url = new URL(href, HH_BASE_URL);
    const vacancyId = url.pathname.match(/\/vacancy\/(\d+)/)?.[1];
    if (vacancyId) return `${url.origin}/vacancy/${vacancyId}`;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return href;
  }
}

export function buildSearchUrl(query: string, pageNum: number, excludedTerms: string[] = []): string {
  const params = new URLSearchParams({
    text: query,
    area: '113',
    items_on_page: '20',
    page: String(pageNum),
    enable_snippets: 'true',
  });
  if (excludedTerms.length > 0) params.set('excluded_text', excludedTerms.join(','));
//  return `${HH_BASE_URL}/search/vacancy?resume=b182c9b5ff0c6feb260039ed1f4d5976783767&from=resumelist&hhtmFrom=applicant_profile`;//&${params.toString()}`;
  return `${HH_BASE_URL}/search/vacancy?${params.toString()}`;
}

export function findHandledApplicationStatus(text: string): string | undefined {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const statuses: Array<[RegExp, string]> = [
    [/^Вам отказали$/i, 'Работодатель отказал в отклике'],
    [/^Отклик отклон(?:ён|ен)$/i, 'Отклик отклонён'],
    [/^Вы откликнулись$/i, 'Уже откликались'],
    [/^Резюме доставлено$/i, 'Отклик уже отправлен'],
    [/^(?:Ваш )?отклик отправлен(?: работодателю)?$/i, 'Отклик уже отправлен'],
    [/^Вы отказались от этой вакансии$/i, 'Вы уже отказались от вакансии'],
  ];
  return statuses.find(([pattern]) => lines.some((line) => pattern.test(line)))?.[1];
}

export function hasApplicationQuestionnaire(text: string): boolean {
  return /для отклика необходимо ответить на несколько вопросов работодателя/i.test(text);
}

function vacancyKey(url: string): string {
  const normalizedUrl = normalizeVacancyUrl(url);
  const vacancyId = new URL(normalizedUrl, HH_BASE_URL).pathname.match(/\/vacancy\/(\d+)/)?.[1];
  return vacancyId ? `id:${vacancyId}` : normalizedUrl;
}

export function deduplicateVacancies(vacancies: Vacancy[]): Vacancy[] {
  const seen = new Set<string>();
  const unique: Vacancy[] = [];
  for (const vacancy of vacancies) {
    const normalizedUrl = normalizeVacancyUrl(vacancy.url);
    const key = vacancyKey(normalizedUrl);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ ...vacancy, url: normalizedUrl });
  }
  return unique;
}

async function gotoWithRetry(page: Page, url: string, timeout: number, attempts: number): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
      return;
    } catch (err) {
      lastError = err;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
    }
  }
  throw lastError;
}

function assertConfigured(searchQueries: string[], profile: ProfileDoc): void {
  const llm = getLlmConfig();
  if (!llm.apiKey || llm.apiKey.startsWith('sk-replace') || llm.apiKey === 'YOUR_OPENAI_API_KEY') {
    console.log('\n❌ Ошибка: укажи API ключ для провайдера!');
    console.log(`   LLM_PROVIDER=${llm.provider} → ожидается переменная окружения с ключом.`);
    console.log('   Скопируй .env.example в .env и заполни нужный ключ.');
    process.exit(1);
  }
  if (searchQueries.length === 0 || searchQueries.some((q) => q.startsWith('YOUR_SEARCH_QUERY'))) {
    console.log('\n❌ Ошибка: укажи поисковые запросы!');
    console.log(`   Заполни ${QUERIES_FILE} (по одному запросу на строку).`);
    process.exit(1);
  }
  if (profileHasPlaceholders(profile)) {
    console.log('\n❌ Ошибка: заполни свой профиль!');
    console.log(`   Открой ${PROFILE_FILE} и замени YOUR_* на свои данные.`);
    process.exit(1);
  }
  if (!sessionExists()) {
    console.log('\n❌ Сессия не найдена!');
    console.log('   Сначала запусти: npm run login');
    process.exit(1);
  }
}

async function searchVacancies(
  page: Page,
  query: string,
  pageNum = 0,
  excludedTerms: string[] = [],
): Promise<Vacancy[]> {
  const url = buildSearchUrl(query, pageNum, excludedTerms);

  try {
    await gotoWithRetry(page, url, 30_000, getAutomationConfig().readRetries);

    const title = await page.title();
    if (title.toLowerCase().includes('captcha')) {
      console.log('  ⚠️  Сработала капча! Подожди немного и попробуй снова.');
      return [];
    }

    await page.waitForSelector("[data-qa='vacancy-serp__vacancy']", { timeout: 10_000 });

    const cards = await page.locator("[data-qa='vacancy-serp__vacancy']").all();
    const vacancies: Vacancy[] = [];

    for (const card of cards) {
      try {
        const titleLocator = card.locator("[data-qa='serp-item__title']").first();
        await titleLocator.waitFor({ state: 'visible', timeout: 5_000 });

        const href = await titleLocator.getAttribute('href');
        const vacancyTitle = (await titleLocator.innerText()).trim();
        if (!href) continue;

        const employerLocator = card.locator("[data-qa='vacancy-serp__vacancy-employer']").first();
        const employer = (await employerLocator.count()) > 0
          ? (await employerLocator.innerText()).trim()
          : 'Компания';

        vacancies.push({ title: vacancyTitle, url: normalizeVacancyUrl(href), employer });
      } catch {
        continue;
      }
    }

    return vacancies;
  } catch (err) {
    console.log(`  ⚠️  Ошибка поиска: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

async function getVacancyDetails(page: Page, url: string): Promise<VacancyDetails> {
  try {
    await gotoWithRetry(page, url, 15_000, getAutomationConfig().readRetries);
    const jsonLdScripts = await page.locator("script[type='application/ld+json']").allTextContents();
    const sourceHtml = await page.content();

    let description = '';
    try {
      await page.waitForSelector("[data-qa='vacancy-description']", { timeout: 10_000 });
      const desc = page.locator("[data-qa='vacancy-description']").first();
      if ((await desc.count()) > 0) description = await desc.innerText();
    } catch {
      // Location data can still be available in JSON-LD when description markup changes.
    }

    return { description, location: parseVacancyLocation(jsonLdScripts, sourceHtml) };
  } catch {
    return { description: '', location: { cities: [], isRemote: false, workFormats: [] } };
  }
}

async function getHandledApplicationStatus(page: Page): Promise<string | undefined> {
  const bodyText = await page.locator('body').innerText().catch(() => '');
  return findHandledApplicationStatus(bodyText);
}

const CONFIRMATION_PATTERNS = [
  'Вы откликнулись',
  'Резюме доставлено',
  'Отклик отправлен',
  'Ваш отклик отправлен',
  'Отклик отправлен работодателю',
];

async function responseConfirmed(page: Page): Promise<boolean> {
  const bodyText = await page.locator('body').innerText().catch(() => '');
  return CONFIRMATION_PATTERNS.some((p) => bodyText.includes(p));
}

async function applicationFailureReason(page: Page): Promise<string> {
  const bodyText = await page.locator('body').innerText().catch(() => '');
  const lines = bodyText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (/номер телефона|напишите телефон/i.test(bodyText)) {
    return 'HH требует номер телефона перед отправкой отклика';
  }
  if (/captcha|капч/i.test(bodyText)) return 'HH показал CAPTCHA';

  const signals = lines
    .filter((line) => /отклик|резюме|ошибк|телефон|пожалуйста/i.test(line))
    .slice(0, 4);
  return signals.length > 0
    ? `HH не подтвердил отправку отклика. Сигналы страницы: ${signals.join(' | ')}`
    : 'HH не подтвердил отправку отклика; подходящий статус не найден';
}

async function applicationFailureResult(page: Page): Promise<ApplyResult> {
  const bodyText = await page.locator('body').innerText().catch(() => '');
  if (hasApplicationQuestionnaire(bodyText)) {
    return {
      status: 'skipped',
      reason: 'HH требует ответить на вопросы работодателя; автоматический ответ не настроен',
    };
  }
  return { status: 'error', reason: await applicationFailureReason(page) };
}

async function resultAfterSubmit(page: Page, successReason: string): Promise<ApplyResult> {
  if (await responseConfirmed(page)) return { status: 'success', reason: successReason };

  // HH may navigate to a questionnaire page after the main submit. Detect and answer it.
  const handled = await handleQuestionnaireIfPresent(page);
  if (handled) return handled;

  return applicationFailureResult(page);
}

async function fillCoverLetter(
  page: Page,
  message: string,
): Promise<boolean> {
  // The textarea is only present after clicking "Добавить" near "Сопроводительное письмо".
  const addBtn = page
    .locator("button:has-text('Добавить'), a:has-text('Добавить')")
    .filter({ has: page.locator("xpath=ancestor::*[contains(., 'сопроводительное письмо') or contains(., 'Сопроводительное письмо')]") })
    .first();
  if ((await addBtn.count()) > 0) {
    await addBtn.click();
    await page.waitForTimeout(1_000);
  }

  const letterArea = page
    .locator("textarea[data-qa='vacancy-response-popup-form-letter-input']")
    .first();
  if ((await letterArea.count()) === 0) return false;
  await letterArea.fill(message);
  await page.waitForTimeout(500);
  return true;
}

async function handleQuestionnaireIfPresent(page: Page): Promise<ApplyResult | undefined> {
  const bodyText = await page.locator('body').innerText().catch(() => '');
  if (!isQuestionnairePage(bodyText)) return undefined;

  const form = await extractQuestionnaire(page);
  if (!form || form.questions.length === 0) {
    return {
      status: 'skipped',
      reason: 'HH показал страницу с вопросами, но структура формы не распознана',
    };
  }

  const resume = loadResume() || buildProfilePrompt();
  const answers = await answerQuestionnaire({ questions: form.questions, resume });
  if (!answers) {
    return {
      status: 'skipped',
      reason: 'LLM не вернул ответы на вопросы работодателя',
    };
  }

  const filled = answersToValues(answers, form.questions);
  await fillQuestionnaire(page, form, filled);

  console.log(`      📝 Ответы LLM на ${form.questions.length} вопросов применены, отправляю...`);

  const submit = page.locator(form.submitSelector).first();
  if ((await submit.count()) === 0) {
    return { status: 'error', reason: 'Кнопка отправки анкеты не найдена' };
  }
  await submit.click();
  await page.waitForTimeout(3_000);

  if (await responseConfirmed(page)) {
    return { status: 'success', reason: 'Отправлено с ответами на вопросы' };
  }
  return applicationFailureResult(page);
}

function answersToValues(
  answers: Record<string, string | null>,
  questions: ReadonlyArray<Questionnaire['questions'][number]>,
): Record<string, string | string[] | undefined> {
  const result: Record<string, string | string[] | undefined> = {};
  for (const q of questions) {
    const value = answers[q.name];
    if (value === null || value === undefined) continue;
    if (q.type === 'checkbox') {
      result[q.name] = value.split(',').map((s) => s.trim()).filter(Boolean);
    } else {
      result[q.name] = value;
    }
  }
  return result;
}

async function waitForManualSubmission(page: Page): Promise<ApplyResult> {
  const rl = createInterface({ input, output });
  console.log('\n      ✋ Режим: отправь отклик вручную (включи вопросы, ответь, нажми Отправить).');
  console.log('      ⏳ После отправки вернись сюда и нажми Enter...');
  await rl.question('      ▶ ');
  rl.close();
  await page.waitForTimeout(1_000);
  if (await responseConfirmed(page)) return { status: 'success', reason: 'Отправлено вручную' };
  return applicationFailureResult(page);
}

async function applyToVacancy(page: Page, url: string, message: string, semiAuto: boolean): Promise<ApplyResult> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    await page.waitForTimeout(3_000);

    const handledStatus = await getHandledApplicationStatus(page);
    if (handledStatus) return { status: 'skipped', reason: handledStatus };

    // Способ 1: ссылка "Написать сопроводительное"
    const coverLink = page.locator("a:has-text('Написать сопроводительное')").first();
    if ((await coverLink.count()) > 0 && message) {
      console.log("      🔍 Нашёл ссылку 'Написать сопроводительное'");
      await coverLink.click();
      await page.waitForTimeout(2_000);

      await fillCoverLetter(page, message);

      const submitBtn = page
        .locator(
          "button:has-text('Откликнуться'), button:has-text('Отправить'), button[data-qa='vacancy-response-submit-popup']",
        )
        .first();
      if ((await submitBtn.count()) > 0) {
        await submitBtn.click();
        await page.waitForTimeout(3_000);
        return resultAfterSubmit(page, 'С письмом');
      }
    }

    // Способ 2: dropdown с опцией "С сопроводительным"
    let applyBtn = page.locator("[data-qa='vacancy-response-link-top']").first();
    if ((await applyBtn.count()) === 0) {
      applyBtn = page.locator("[data-qa='vacancy-response-link-bottom']").first();
    }

    if ((await applyBtn.count()) > 0 && message) {
      const dropdown = page
        .locator(
          "[data-qa='vacancy-response-link-top'] ~ button, button[data-qa='vacancy-response-actions-dropdown']",
        )
        .first();
      if ((await dropdown.count()) > 0) {
        console.log('      🔍 Нашёл выпадающее меню');
        await dropdown.click();
        await page.waitForTimeout(1_000);

        const withLetter = page
          .locator("text=С сопроводительным, text=сопроводительным письмом")
          .first();
        if ((await withLetter.count()) > 0) {
          console.log("      🔍 Нашёл опцию 'С сопроводительным'");
          await withLetter.click();
          await page.waitForTimeout(2_000);

          if (await fillCoverLetter(page, message)) {
            console.log('      ✍️  Заполняю письмо...');
          } else {
            console.log('      ⚠️  Поле письма не найдено');
          }

          const submitBtn = page
            .locator("button:has-text('Откликнуться'), button:has-text('Отправить')")
            .first();
          if ((await submitBtn.count()) > 0) {
            await submitBtn.click();
            await page.waitForTimeout(3_000);
            return resultAfterSubmit(page, 'С письмом (меню)');
          }
        }
      }
    }

    // Способ 3: просто жмём "Откликнуться", затем добавляем письмо
    if ((await applyBtn.count()) > 0) {
      if (semiAuto) {
        console.log("      🔍 Жму основную кнопку 'Откликнуться'");
        await applyBtn.click();
        await page.waitForTimeout(3_000);

        if (message) await fillCoverLetter(page, message);
        return waitForManualSubmission(page);
      }
      console.log("      🔍 Жму основную кнопку 'Откликнуться'");
      await applyBtn.click();
      await page.waitForTimeout(3_000);

      let letterFilled = false;
      if (message) letterFilled = await fillCoverLetter(page, message);

      if (letterFilled) {
        const submitBtn = page
          .locator(
            "button:has-text('Отправить'), button:has-text('Откликнуться'), button:has-text('Отправить письмо'), button[type='submit']",
          )
          .first();
        if ((await submitBtn.count()) > 0) {
          console.log('      📨 Нажимаю кнопку отправки...');
          await submitBtn.click();
          await page.waitForTimeout(3_000);
          return resultAfterSubmit(page, 'С письмом (после отклика)');
        }

        const allButtons = await page.locator('button').all();
        for (const btn of allButtons) {
          const txt = (await btn.innerText()).toLowerCase();
          if (txt.includes('отправ') || txt.includes('откликн')) {
            console.log(`      📨 Нашёл кнопку: ${txt}`);
            await btn.click();
            await page.waitForTimeout(3_000);
            return resultAfterSubmit(page, 'С письмом');
          }
        }
      }

      if (await responseConfirmed(page)) return { status: 'success', reason: 'Без письма' };

      return applicationFailureResult(page);
    }

    return { status: 'error', reason: 'Кнопка не найдена' };
  } catch (err) {
    return { status: 'error', reason: err instanceof Error ? err.message : String(err) };
  }
}

async function main(): Promise<void> {
  console.log('\n' + '='.repeat(50));
  console.log('🚀 HH.ru Автооткликатор');
  console.log('='.repeat(50));

  // Load profile before validation so its location rules apply to every vacancy.
  const profile = loadProfile();
  const searchQueries = loadSearchQueries();
  const excludedTerms = loadExcludedText();
  assertConfigured(searchQueries, profile);

  const llm = getLlmConfig();
  const automation = getAutomationConfig();
  const mode = automation.mode === 'semi' ? 'Полуавтоматический (--semi)' : 'Полный автомат';
  console.log(`\n📋 Поисковые запросы: ${searchQueries.join(', ')}`);
  console.log(`📄 Страниц на запрос: ${automation.maxPages}`);
  console.log(`⏱️  Пауза между откликами: ${automation.delayBetweenAppliesSeconds} сек`);
  console.log(`🔁 Повторы чтения/LLM: ${automation.readRetries}/${automation.llmRetries}`);
  console.log(`🤖 LLM: ${llm.provider} / ${llm.model}`);
  console.log(`🚫 Исключения: ${excludedTerms.length}`);
  console.log(`⚙️  Режим: ${mode}`);
  if (automation.dryRun) console.log('🧪 Dry-run: письма и отклики не отправляются');

  const stats = { success: 0, skipped: 0, error: 0 };
  const seenVacancies = new Set<string>();

  const browser = await chromium.launch({ headless: false, slowMo: 300 });
  const context = await browser.newContext({ storageState: SESSION_FILE });
  const page = await context.newPage();

  try {
    for (const query of searchQueries) {
      console.log(`\n🔍 Поиск: ${query}`);

      for (let pageNum = 0; pageNum < automation.maxPages; pageNum++) {
        console.log(`  📄 Страница ${pageNum + 1}`);

        const vacancies = deduplicateVacancies(
          await searchVacancies(page, query, pageNum, excludedTerms),
        ).filter((vacancy) => {
          const key = vacancyKey(vacancy.url);
          if (seenVacancies.has(key)) return false;
          seenVacancies.add(key);
          return true;
        });
        console.log(`  📊 Найдено вакансий: ${vacancies.length}`);

        for (const [i, vacancy] of vacancies.entries()) {
          console.log(`\n  [${i + 1}/${vacancies.length}] ${vacancy.title.slice(0, 50)}...`);
          console.log(`      Компания: ${vacancy.employer}`);

          const titleMatch = findExcludedTerm(`${vacancy.title}\n${vacancy.employer}`, excludedTerms);
          if (titleMatch) {
            console.log(`      ⏭️  Пропущено по исключению: ${titleMatch}`);
            stats.skipped++;
            continue;
          }

          const details = await getVacancyDetails(page, vacancy.url);
          const handledStatus = await getHandledApplicationStatus(page);
          if (handledStatus) {
            console.log(`      ⏭️  Пропущено: ${handledStatus}`);
            stats.skipped++;
            continue;
          }
          const descriptionMatch = findExcludedTerm(details.description, excludedTerms);
          if (descriptionMatch) {
            console.log(`      ⏭️  Пропущено по исключению: ${descriptionMatch}`);
            stats.skipped++;
            continue;
          }
          const location = checkLocationEligibility(
            details.location,
            profile.onsite_cities,
            details.location.workFormats,
          );
          if (!location.eligible) {
            console.log(`      ⏭️  Пропущено по локации: ${location.reason}`);
            stats.skipped++;
            continue;
          }
          console.log(`      Link: ${vacancy.url}`);
          console.log(`      📍 Локация: ${location.reason}`);

          console.log('      💬 Генерирую письмо...');
          let letter = '';
          const cached = loadCachedCoverLetter(vacancy);
          if (cached) {
            letter = cached;
            console.log('      ♻️  Используется сохранённое письмо из letters/');
          } else if (automation.dryRun) {
            console.log('      🧪 Dry-run: письмо не сгенерировано и не отправлено');
          } else {
            const letterResult = await generateCoverLetter(vacancy.title, vacancy.employer, details.description);
            letter = letterResult.text;

            if (letter) console.log(`      📝 Письмо: ${letter.slice(0, 80)}...`);
            if (!letter) {
              console.log(`      ⏭️  Пропущено: ${letterResult.reason ?? 'письмо не сгенерировано'}`);
              stats.skipped++;
              continue;
            }

            try {
              const letterPath = saveCoverLetter(vacancy, letter);
              console.log(`      💾 Письмо сохранено: ${letterPath}`);
            } catch (err) {
              const reason = err instanceof Error ? err.message : String(err);
              console.log(`      ❌ Ошибка сохранения письма: ${reason}`);
              stats.error++;
              continue;
            }
          }

          if (automation.dryRun) {
            console.log('      🧪 Dry-run: отклик не отправлен');
            stats.skipped++;
            console.log(`      ⏳ Пауза ${automation.delayBetweenAppliesSeconds} сек...`);
            await new Promise((r) => setTimeout(r, automation.delayBetweenAppliesSeconds * 1000));
            continue;
          }

          console.log('      📤 Отправляю отклик...');
          const result = await applyToVacancy(page, vacancy.url, letter, automation.mode === 'semi');

          if (result.status === 'success') {
            console.log(`      ✅ Успех! (${result.reason})`);
            stats.success++;
          } else if (result.status === 'skipped') {
            console.log(`      ⏭️  Пропущено: ${result.reason}`);
            stats.skipped++;
          } else {
            console.log(`      ❌ Ошибка: ${result.reason}`);
            stats.error++;
          }

          console.log(`      ⏳ Пауза ${automation.delayBetweenAppliesSeconds} сек...`);
          await new Promise((r) => setTimeout(r, automation.delayBetweenAppliesSeconds * 1000));
        }
      }
    }
  } finally {
    await browser.close();
  }

  console.log('\n' + '='.repeat(50));
  console.log('📊 ИТОГИ:');
  console.log(`   ✅ Успешно: ${stats.success}`);
  console.log(`   ⏭️  Пропущено: ${stats.skipped}`);
  console.log(`   ❌ Ошибок: ${stats.error}`);
  console.log('='.repeat(50) + '\n');
}

const isEntryPoint = process.argv[1]
  ? path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])
  : false;

if (isEntryPoint) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
