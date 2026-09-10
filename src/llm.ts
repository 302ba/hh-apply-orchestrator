import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import {
  getAutomationConfig,
  getLlmConfig,
  getLlmSampling,
  OPENCODE_SESSION_HEADER,
  OPENCODE_SESSION_ID,
} from './config.js';
import { loadProfile, loadResume, profileToPromptString } from './config-loader.js';
import { fileConsole } from './logger.js';

const console = fileConsole;

export function buildProfilePrompt(): string {
  return profileToPromptString(loadProfile());
}

const RESUME_MODE_PROMPT = `/no_think

Напиши сопроводительное письмо для этой вакансии.

Я хочу получить короткое, естественное и персонализированное письмо, которое не выглядит сгенерированным ИИ.

Не выдумывай никакие факты.

### МОЁ РЕЗЮМЕ

[ВСТАВЬ CV]

### ВАКАНСИЯ

[ВСТАВЬ ТЕКСТ ВАКАНСИИ]

Выдай только готовое сопроводительное письмо без анализа.`;

function buildClient() {
  const { provider, apiKey, baseURL } = getLlmConfig();
  const defaultHeaders: Record<string, string> = {};
  if (provider === 'opencode-go' || provider === 'opencode-zen') {
    defaultHeaders[OPENCODE_SESSION_HEADER] = OPENCODE_SESSION_ID;
  }

  // OpenRouter wants attribution headers to rank your app; harmless if ignored.
  if (provider === 'openrouter') {
    defaultHeaders['HTTP-Referer'] = process.env.OPENROUTER_REFERER ?? 'https://localhost';
    defaultHeaders['X-OpenRouter-Title'] = process.env.OPENROUTER_TITLE ?? 'hh-auto-apply';
  }

  const opts: ConstructorParameters<typeof OpenAI>[0] = { apiKey };
  if (baseURL) opts.baseURL = baseURL;
  if (Object.keys(defaultHeaders).length > 0) opts.defaultHeaders = defaultHeaders;

  const client = new OpenAI(opts);
  return client;
}

function buildAnthropicClient() {
  const { apiKey, baseURL, provider } = getLlmConfig();
  return new Anthropic({
    apiKey,
    baseURL: baseURL.replace(/\/v1\/?$/, ''),
    defaultHeaders: provider === 'opencode-go' || provider === 'opencode-zen'
      ? { [OPENCODE_SESSION_HEADER]: OPENCODE_SESSION_ID }
      : undefined,
  });
}

function usesMessagesEndpoint(provider: string, model: string): boolean {
  return provider === 'opencode-go' && /^(?:qwen|minimax-m)/i.test(model);
}

const COVER_LETTER_SYSTEM_PROMPT = `Ты — профессиональный карьерный консультант и редактор сопроводительных писем.

Твоя задача — писать персонализированные сопроводительные письма на основе:

1. резюме кандидата;
2. текста вакансии;
3. дополнительных инструкций кандидата.

Главная цель — показать, почему опыт и навыки кандидата релевантны именно этой вакансии.

ПРАВИЛА:

* Никогда не выдумывай опыт, должности, компании, проекты, технологии, достижения, образование или другие факты, которых нет в резюме или дополнительных данных.
* Не приписывай кандидату навыки только потому, что они указаны в вакансии.
* Если в вакансии требуется навык, которого нет в резюме, не утверждай, что кандидат им владеет.
* Используй конкретные факты из резюме вместо общих фраз.
* Не пересказывай всё резюме. Выбирай только наиболее релевантные для вакансии детали.
* Анализируй требования вакансии и связывай их с опытом кандидата.
* Письмо должно выглядеть написанным человеком, а не шаблонным текстовым генератором.
* Не используй чрезмерно формальный, канцелярский или восторженный стиль.
* Не используй клише вроде:
  «с большим интересом ознакомился с вашей вакансией»,
  «буду рад стать частью вашей команды»,
  «ваша компания является лидером рынка»,
  «уникальная возможность»,
  «богатый опыт»,
  «динамично развивающаяся компания».
  Используй их только если они действительно необходимы и естественно вписываются в текст.
* Не повторяй название вакансии и компании без необходимости.
* Не перечисляй навыки через запятую без объяснения их связи с вакансией.
* Не копируй формулировки из вакансии дословно.
* Не преувеличивай достижения.
* Не используй слишком длинные предложения.
* Избегай искусственного корпоративного языка.
* Пиши конкретно, естественно и уверенно.

СТРУКТУРА:

1. Короткое вступление: на какую позицию кандидат откликается и почему она ему подходит.
2. 1–2 абзаца с наиболее релевантным опытом кандидата.
3. Связь конкретного опыта кандидата с ключевыми требованиями вакансии.
4. Короткое завершение без чрезмерной формальности.

ДЛИНА:

Обычно 150–250 слов.
Если вакансия или контекст требуют более короткого письма — 100–150 слов.
Не увеличивай письмо просто ради объёма.

СТИЛЬ:

Пиши естественным современным языком.
Тон — профессиональный, уверенный и спокойный.
Не пытайся звучать «слишком умно».
Не используй эмодзи.
Не добавляй заголовок «Сопроводительное письмо», если пользователь этого не просил.
Не добавляй тему email, приветствие или подпись, если пользователь отдельно этого не попросил.

ПЕРЕД НАПИСАНИЕМ:

Мысленно определи:

* 3–5 наиболее важных требований вакансии;
* какие факты из резюме подтверждают соответствие этим требованиям;
* какие сильные стороны кандидата лучше всего подчеркнуть.

Не показывай этот анализ пользователю. Сразу выдай готовое письмо.

Если информации недостаточно для качественного письма, не выдумывай недостающие факты. Используй только имеющиеся данные.`;

export interface CoverLetterResult {
  text: string;
  reason?: string;
}

export function cleanCoverLetter(text: string): string {
  return text
    .replace(/\[(?:ссылка(?: на сайт)?|сайт|website|portfolio|link|YOUR_[A-Z_]+)\]/giu, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .trim();
}

export async function generateCoverLetter(
  title: string,
  employer: string,
  description: string,
): Promise<CoverLetterResult> {
  const { model, provider } = getLlmConfig();
  const useResume = (process.env.RESUME_MODE ?? '').toLowerCase() === 'true'
    || process.argv.includes('--resume');
  const resume = useResume ? loadResume() : '';

  const profile = useResume && resume ? '' : buildProfilePrompt();

  const prompt = useResume && resume
    ? RESUME_MODE_PROMPT
        .replace('[ВСТАВЬ CV]', resume)
        .replace('[ВСТАВЬ ТЕКСТ ВАКАНСИИ]', description.slice(0, 2500))
    : `${COVER_LETTER_SYSTEM_PROMPT}

ОБО МНЕ:
${profile}

ВАКАНСИЯ:
Название: ${title}
Компания: ${employer}
Описание: ${description.slice(0, 2500)}

Напиши только текст письма, без комментариев.`;

  const { llmRetries, llmMaxTokens } = getAutomationConfig();
  const sampling = getLlmSampling();
  for (let attempt = 1; attempt <= llmRetries; attempt++) {
    try {
      if (usesMessagesEndpoint(provider, model)) {
        const response = await buildAnthropicClient().messages.create({
          model,
          // Cover letters need direct text, not a reasoning trace.
          thinking: { type: 'disabled' },
          max_tokens: llmMaxTokens,
          temperature: sampling.temperature,
          top_p: sampling.topP,
          top_k: sampling.topK,
          messages: [{ role: 'user', content: prompt }],
        });
        const text = cleanCoverLetter(response.content
          .filter((block): block is Anthropic.TextBlock => block.type === 'text')
          .map((block) => block.text)
          .join('')
        );
        if (text) return { text };

        const blockTypes = response.content.map((block) => block.type).join(', ') || 'нет';
        const tokenHint = response.stop_reason === 'max_tokens'
          ? 'Лимит токенов исчерпан до финального текста'
          : 'Финальный текст не был выдан';
        return {
          text: '',
          reason: `Пустой ответ ${provider}/${model}: блоки [${blockTypes}], stop_reason=${response.stop_reason ?? 'не указан'}. ${tokenHint}`,
        };
      }

      const response = await buildClient().chat.completions.create({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: llmMaxTokens,
        temperature: sampling.temperature,
        top_p: sampling.topP,
        frequency_penalty: Math.max(0, sampling.repeatPenalty - 1),
        presence_penalty: 0,
      });
      const text = cleanCoverLetter(response.choices[0]?.message?.content ?? '');
      if (text) return { text };

      const choice = response.choices[0];
      const refusal = choice?.message?.refusal;
      return {
        text: '',
        reason: refusal
          ? `Провайдер отклонил запрос: ${refusal}`
          : `Пустой ответ ${provider}/${model}: choices=${response.choices.length}, finish_reason=${choice?.finish_reason ?? 'не указан'}`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (attempt === llmRetries) {
        console.log(`  ⚠️  Ошибка генерации письма после ${attempt} попыток: ${message}`);
        return { text: '', reason: `Ошибка провайдера после ${attempt} попыток: ${message}` };
      }
      console.log(`  ⚠️  Ошибка генерации письма (${attempt}/${llmRetries}), повторяю...`);
      await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
    }
  }

  return { text: '', reason: 'Генерация письма не выполнена' };
}
