# hh-auto-apply

TypeScript-автоматизация откликов на HH.ru с AI-генерацией сопроводительных писем. По мотивам https://github.com/Killblonde/hh-auto-apply.git

## Возможности

- Поиск вакансий по нескольким запросам
- Фильтрация через HH `excluded_text` и локальная проверка описания
- Фильтрация по городам для работы на месте
- Поддержка удалённых вакансий через HH `workFormats`
- Пропуск ранее обработанных, отклонённых и уже отправленных откликов
- Дедупликация вакансий между запросами
- Проверка подтверждения отклика на HH
- Логи с причинами пропусков и ошибок

## Установка

Требуется Node.js 20+.

```bash
npm install
npx playwright install chromium
```

## Настройка

Создай `.env` из `.env.example` и укажи провайдера и API-ключ:

```env
LLM_PROVIDER=opencode-go
LLM_MODEL=qwen3.8-flash
OPENCODE_API_KEY=your-api-key
```

Поддерживаемые провайдеры:

- `openai` — OpenAI API
- `openrouter` — OpenRouter API
- `opencode-go` — OpenCode Go API
- `opencode-zen` — OpenCode Zen API
- `opencode` — alias для `opencode-go`
- `lmstudio` — LM Studio local server (`http://localhost:1234/v1`)
- `ollama` — Ollama local server (`http://localhost:11434/v1`)
- `llamacpp` — llama.cpp server (`http://localhost:8080/v1`)

Для локальных провайдеров укажи `LLM_MODEL=<имя модели на сервере>`, например:

```env
LLM_PROVIDER=ollama
LLM_MODEL=llama3.1
# LLM_BASE_URL=http://localhost:11434/v1
```

API-ключ для локальных провайдеров обычно не требуется; задай `LMSTUDIO_API_KEY`, `OLLAMA_API_KEY` или `LLAMACPP_API_KEY`, только если твой сервер требует аутентификации.

Заполни конфигурационные файлы:

- `config/profile.md` — профиль и города для работы на месте
- `config/resume.md` — полный текст резюме (используется при `RESUME_MODE=true`)
- `config/queries.txt` — один поисковый запрос на строку
- `config/excluded.csv` — исключаемые слова через запятую

Для режима резюме (более естественный промпт, без переноса структурированных полей):

```env
RESUME_MODE=true
# или
npm run apply -- --resume
```

Пример городов в `config/profile.md`:

```yaml
onsite_cities:
  - Волгоград
  - Волжский
```

Вакансия из другого города проходит фильтр только при выбранном удалённом формате.

## Запуск

Сначала авторизуйся на HH.ru:

```bash
npm run login
```

Затем запусти отклики:

```bash
npm run apply
```

Браузер открывается в видимом режиме. Каждый запуск сохраняет логи в отдельный timestamped-файл внутри `logs/`, а сгенерированные письма — в `letters/`. Пути можно переопределить через `LOG_FILE` и `LETTERS_DIR`.

Для полуавтоматического режима (ручной отклик с AI-писмом):

```bash
npm run apply -- --semi
# или
SEMI_AUTO=true npm run apply
```

Для предварительного просмотра без отправки писем и откликов:

```bash
npm run apply -- --dry
# или
DRY_RUN=true npm run apply
```

## Проверка

```bash
npm run typecheck
npm test
npm run build
```

Подробная инструкция: [`SETUP_GUIDE.md`](SETUP_GUIDE.md).
