import { chromium, type Page } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
  PROFILE_FILE,
  loadProfile,
  loadSearchQueries,
  profileHasPlaceholders,
  type ProfileDoc,
} from './config-loader.js';
import { generateCoverLetter } from './llm.js';
import { findExcludedTerm } from './exclusions.js';
import { checkLocationEligibility, parseVacancyLocation, type VacancyLocation } from './vacancy-location.js';
import { fileConsole } from './logger.js';

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
  ];
  return statuses.find(([pattern]) => lines.some((line) => pattern.test(line)))?.[1];
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
    return { description: '', location: { cities: [], isRemote: false } };
  }
}

async function getHandledApplicationStatus(page: Page): Promise<string | undefined> {
  const bodyText = await page.locator('body').innerText().catch(() => '');
  return findHandledApplicationStatus(bodyText);
}

async function responseConfirmed(page: Page): Promise<boolean> {
  const confirmation = page.locator("text=Вы откликнулись, text=Резюме доставлено").first();
  try {
    await confirmation.waitFor({ state: 'visible', timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

async function applyToVacancy(page: Page, url: string, message: string): Promise<ApplyResult> {
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

      const letterArea = page.locator('textarea').first();
      if ((await letterArea.count()) > 0) {
        console.log('      ✍️  Заполняю письмо...');
        await letterArea.fill(message);
        await page.waitForTimeout(500);

        const submitBtn = page
          .locator(
            "button:has-text('Откликнуться'), button:has-text('Отправить'), button[data-qa='vacancy-response-submit-popup']",
          )
          .first();
        if ((await submitBtn.count()) > 0) {
          await submitBtn.click();
          await page.waitForTimeout(3_000);
          return (await responseConfirmed(page))
            ? { status: 'success', reason: 'С письмом' }
            : { status: 'error', reason: 'HH не подтвердил отправку отклика' };
        }
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

          const letterArea = page.locator('textarea').first();
          if ((await letterArea.count()) > 0) {
            console.log('      ✍️  Заполняю письмо...');
            await letterArea.fill(message);
            await page.waitForTimeout(500);

            const submitBtn = page
              .locator("button:has-text('Откликнуться'), button:has-text('Отправить')")
              .first();
            if ((await submitBtn.count()) > 0) {
              await submitBtn.click();
              await page.waitForTimeout(3_000);
              return (await responseConfirmed(page))
                ? { status: 'success', reason: 'С письмом (меню)' }
                : { status: 'error', reason: 'HH не подтвердил отправку отклика' };
            }
          }
        }
      }
    }

    // Способ 3: просто жмём "Откликнуться", затем добавляем письмо
    if ((await applyBtn.count()) > 0) {
      console.log("      🔍 Жму основную кнопку 'Откликнуться'");
      await applyBtn.click();
      await page.waitForTimeout(3_000);

      const letterArea = page.locator('textarea').first();
      if ((await letterArea.count()) > 0 && message) {
        console.log('      ✍️  Появилось поле для письма, заполняю...');
        await letterArea.fill(message);
        await page.waitForTimeout(1_000);

        const submitBtn = page
          .locator(
            "button:has-text('Отправить'), button:has-text('Откликнуться'), button:has-text('Отправить письмо'), button[type='submit']",
          )
          .first();
        if ((await submitBtn.count()) > 0) {
          console.log('      📨 Нажимаю кнопку отправки...');
          await submitBtn.click();
          await page.waitForTimeout(3_000);
          return (await responseConfirmed(page))
            ? { status: 'success', reason: 'С письмом (после отклика)' }
            : { status: 'error', reason: 'HH не подтвердил отправку отклика' };
        }

        const allButtons = await page.locator('button').all();
        for (const btn of allButtons) {
          const txt = (await btn.innerText()).toLowerCase();
          if (txt.includes('отправ') || txt.includes('откликн')) {
            console.log(`      📨 Нашёл кнопку: ${txt}`);
            await btn.click();
            await page.waitForTimeout(3_000);
            return (await responseConfirmed(page))
              ? { status: 'success', reason: 'С письмом' }
              : { status: 'error', reason: 'HH не подтвердил отправку отклика' };
          }
        }
      }

      if (await responseConfirmed(page)) return { status: 'success', reason: 'Без письма' };

      return { status: 'error', reason: 'HH не подтвердил отправку отклика' };
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
  console.log(`\n📋 Поисковые запросы: ${searchQueries.join(', ')}`);
  console.log(`📄 Страниц на запрос: ${automation.maxPages}`);
  console.log(`⏱️  Пауза между откликами: ${automation.delayBetweenAppliesSeconds} сек`);
  console.log(`🔁 Повторы чтения/LLM: ${automation.readRetries}/${automation.llmRetries}`);
  console.log(`🤖 LLM: ${llm.provider} / ${llm.model}`);
  console.log(`🚫 Исключения: ${excludedTerms.length}`);

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
          const location = checkLocationEligibility(details.location, profile.onsite_cities);
          if (!location.eligible) {
            console.log(`      ⏭️  Пропущено по локации: ${location.reason}`);
            stats.skipped++;
            continue;
          }
          console.log(`      Link: ${vacancy.url}`);
          console.log(`      📍 Локация: ${location.reason}`);

          console.log('      💬 Генерирую письмо...');
          const letterResult = await generateCoverLetter(vacancy.title, vacancy.employer, details.description);
          const letter = letterResult.text;

          if (letter) console.log(`      📝 Письмо: ${letter.slice(0, 80)}...`);
          if (!letter) {
            console.log(`      ⏭️  Пропущено: ${letterResult.reason ?? 'письмо не сгенерировано'}`);
            stats.skipped++;
            continue;
          }

          console.log('      📤 Отправляю отклик...');
          const result = await applyToVacancy(page, vacancy.url, letter);

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
