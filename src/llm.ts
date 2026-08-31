import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { getAutomationConfig, getLlmConfig } from './config.js';
import { loadProfile, profileToPromptString } from './config-loader.js';
import { fileConsole } from './logger.js';

const console = fileConsole;

export function buildProfilePrompt(): string {
  return profileToPromptString(loadProfile());
}

function buildClient() {
  const { provider, apiKey, baseURL } = getLlmConfig();
  const opts: ConstructorParameters<typeof OpenAI>[0] = { apiKey };
  if (baseURL) opts.baseURL = baseURL;

  const client = new OpenAI(opts);

  // OpenRouter wants attribution headers to rank your app; harmless if ignored.
  if (provider === 'openrouter') {
    (client as unknown as { defaultHeaders: Record<string, string> }).defaultHeaders = {
      ...(client as unknown as { defaultHeaders?: Record<string, string> }).defaultHeaders,
      'HTTP-Referer': process.env.OPENROUTER_REFERER ?? 'https://localhost',
      'X-OpenRouter-Title': process.env.OPENROUTER_TITLE ?? 'hh-auto-apply',
    };
  }
  return client;
}

function buildAnthropicClient() {
  const { apiKey, baseURL } = getLlmConfig();
  return new Anthropic({
    apiKey,
    baseURL: baseURL.replace(/\/v1\/?$/, ''),
  });
}

function usesMessagesEndpoint(provider: string, model: string): boolean {
  return provider === 'opencode-go' && /^(?:qwen|minimax-m)/i.test(model);
}

export interface CoverLetterResult {
  text: string;
  reason?: string;
}

export async function generateCoverLetter(
  title: string,
  employer: string,
  description: string,
): Promise<CoverLetterResult> {
  const { model, provider } = getLlmConfig();
  const profile = buildProfilePrompt();
  const prompt = `Напиши сопроводительное письмо для отклика на вакансию. Пиши как живой человек, не как робот.

СТРУКТУРА ПИСЬМА:
1. Приветствие (Добрый день! или Здравствуйте!)
2. Представься кратко (имя, чем занимаюсь)
3. Почему заинтересовала именно эта вакансия/компания (найди что-то конкретное в описании)
4. Кратко релевантный опыт (1-2 примера кейсов которые подходят под вакансию)
5. Призыв к действию + ссылка на сайт с кейсами (если есть)

ПРАВИЛА:
- Длина: 4-6 предложений, не больше
- Тон: дружелюбный, профессиональный, но не официозный
- Без штампов: "с большим интересом", "буду рад", "внести вклад", "рассмотрите мою кандидатуру"
- Без длинных тире (—), без восклицательных знаков в конце каждого предложения
- Пиши так, будто реальный человек пишет реальному человеку
- Русский язык

ОБО МНЕ:
${profile}

ВАКАНСИЯ:
Название: ${title}
Компания: ${employer}
Описание: ${description.slice(0, 2500)}

Напиши только текст письма, без комментариев.`;

  const { llmRetries, llmMaxTokens } = getAutomationConfig();
  for (let attempt = 1; attempt <= llmRetries; attempt++) {
    try {
      if (usesMessagesEndpoint(provider, model)) {
        const response = await buildAnthropicClient().messages.create({
          model,
          // Cover letters need direct text, not a reasoning trace.
          thinking: { type: 'disabled' },
          max_tokens: llmMaxTokens,
          temperature: 0.8,
          messages: [{ role: 'user', content: prompt }],
        });
        const text = response.content
          .filter((block): block is Anthropic.TextBlock => block.type === 'text')
          .map((block) => block.text)
          .join('')
          .trim();
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
        temperature: 0.8,
      });
      const text = response.choices[0]?.message?.content?.trim() ?? '';
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
