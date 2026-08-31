# HH.ru Автооткликатор — Гайд по настройке

## Что это?

Автоматическая система для откликов на вакансии HH.ru:
- Ищет вакансии по твоим запросам
- Генерирует персонализированные сопроводительные письма через ChatGPT
- Автоматически откликается с этими письмами
- Не откликается повторно на те же вакансии

## Что нужно для работы

1. **Node.js 20+** — среда выполнения TypeScript
2. **API ключ выбранного LLM-провайдера** — OpenAI, OpenRouter или OpenCode Zen
3. **Аккаунт на HH.ru** — с заполненным резюме
4. **Mac или Windows** — Linux тоже работает

## Пошаговая установка

### Шаг 1: Установка Node.js

**Mac:**
```bash
# Проверь установленную версию Node.js
node --version

# Если нет — установи через Homebrew
brew install node
```

**Windows:**
Скачай с https://nodejs.org/

### Шаг 2: Установка зависимостей

```bash
npm install
npx playwright install chromium
```

### Шаг 3: Настройка

```bash
cp .env.example .env
```

Заполни `.env`:

- `LLM_PROVIDER=openai`, `openrouter`, `opencode-go` или `opencode-zen`
- `opencode` также принимается как alias для `opencode-go`
- Ключ соответствующего провайдера
- При необходимости `LLM_MODEL`
- `HH_MAX_PAGES`, `HH_DELAY_BETWEEN_APPLIES_SECONDS` и retry-настройки
- `LOG_FILE` — необязательный путь к файлу журнала; по умолчанию создаётся отдельный timestamped-файл в `logs/`

Заполни конфигурационные файлы:

- `config/profile.md` — профиль и `onsite_cities`
- `config/queries.txt` — один поисковый запрос на строку
- `config/excluded.csv` — исключаемые технологии и текст через запятую

Например:

```yaml
onsite_cities:
  - Волгоград
  - Волжский
```

Вакансии в других городах обрабатываются только если HH указывает `REMOTE` в `workFormats`.

Если название или описание вакансии содержит исключаемый термин, вакансия пропускается до генерации письма. Например:

```text
1c,bitrix,go,java,.net,python,react
```

### Шаг 4: API ключ

Ключи создаются на сайте выбранного провайдера:

- OpenAI: https://platform.openai.com/api-keys
- OpenRouter: https://openrouter.ai/keys
- OpenCode Go/Zen: https://opencode.ai/auth

Для OpenCode Go модель `qwen3.8-flash` автоматически вызывается через Anthropic-compatible endpoint. OpenAI-compatible модели Go используют Chat Completions.

### Шаг 5: Авторизация на HH.ru

```bash
npm run login
```

Откроется браузер — залогинься на HH.ru и нажми Enter в терминале.

### Шаг 6: Запуск!

```bash
npm run apply
```

Вывод `npm run apply` сохраняется в отдельный timestamped-файл в `logs/`. Авторизация через `npm run login` по-прежнему использует консоль, потому что ожидает ручной вход в браузере.

## Ежедневное использование

Просто запускай:
```bash
cd ~/hh-automation
npm run apply
```

## Советы

- Запускай 1-2 раза в день максимум
- Раз в неделю обновляй сессию через `npm run login`
- Не ставь `HH_DELAY_BETWEEN_APPLIES_SECONDS` меньше 5 секунд

## Частые ошибки

**"Session file not found"**
→ Запусти `npm run login`

**"Executable doesn't exist"**
→ Запусти `npx playwright install chromium`

**"Model ... is not supported"**
→ Проверь `LLM_MODEL`; используй модель, доступную выбранному провайдеру
