import { chromium, type BrowserContext } from 'playwright';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SESSION_DIR, SESSION_FILE, ensureSessionDir } from './config.js';

async function login(): Promise<void> {
  ensureSessionDir();

  console.log('\n' + '='.repeat(50));
  console.log('🔐 HH.ru Авторизация');
  console.log('='.repeat(50));

  const browser = await chromium.launch({ headless: false });
  const context: BrowserContext = await browser.newContext();
  const page = await context.newPage();

  await page.goto('https://hh.ru/login');

  console.log('\n📌 Инструкция:');
  console.log('1. В открывшемся браузере войди в свой аккаунт HH.ru');
  console.log('2. Дождись загрузки личного кабинета');
  console.log('3. Вернись сюда и нажми Enter');
  console.log('\n⏳ Жду пока ты залогинишься...');

  const rl = createInterface({ input, output });
  await rl.question('\n✅ Нажми Enter когда залогинился...\n');
  rl.close();

  await context.storageState({ path: SESSION_FILE });

  console.log(`\n✅ Сессия сохранена в ${SESSION_FILE}`);
  console.log('🎉 Теперь можешь запускать npm run apply!');

  await browser.close();
}

export function getCookies(): string | null {
  if (!fs.existsSync(SESSION_FILE)) {
    console.log('❌ Сессия не найдена. Сначала запусти login.');
    return null;
  }

  const raw = fs.readFileSync(SESSION_FILE, 'utf-8');
  const state = JSON.parse(raw) as { cookies?: Array<{ name: string; value: string }> };
  const cookies = state.cookies ?? [];
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

const isEntryPoint = process.argv[1]
  ? path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])
  : false;

if (isEntryPoint) {
  const flag = process.argv[2];
  if (flag === '--get-cookies') {
    console.log(getCookies());
  } else {
    login().catch((err) => {
      console.error(err);
      process.exit(1);
    });
  }
}

export { login, SESSION_DIR, SESSION_FILE };
