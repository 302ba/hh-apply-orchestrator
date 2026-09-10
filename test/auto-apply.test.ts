import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildSearchUrl,
  deduplicateVacancies,
  findHandledApplicationStatus,
  hasApplicationQuestionnaire,
  normalizeVacancyUrl,
} from '../src/auto-apply.ts';
import { getAutomationConfig, getLlmConfig, getLlmSampling } from '../src/config.ts';
import { parseCsvList, loadResume } from '../src/config-loader.ts';
import { findExcludedTerm } from '../src/exclusions.ts';
import { saveCoverLetter } from '../src/letters.ts';
import { cleanCoverLetter } from '../src/llm.ts';
import { checkLocationEligibility, parseVacancyLocation } from '../src/vacancy-location.ts';

test('normalizes vacancy URLs and removes tracking parameters', () => {
  assert.equal(normalizeVacancyUrl('/vacancy/123?hhtmFrom=search#details'), 'https://hh.ru/vacancy/123');
});

test('passes excluded terms to HH search URL', () => {
  const url = new URL(buildSearchUrl('PHP Laravel', 0, ['1c', 'c++', '.net']));

  assert.equal(url.searchParams.get('excluded_text'), '1c,c++,.net');
  assert.equal(url.searchParams.get('enable_snippets'), 'true');
});

test('detects rejected and already-submitted application statuses', () => {
  assert.equal(findHandledApplicationStatus('Формат работы\nУдалённо\nВам отказали'), 'Работодатель отказал в отклике');
  assert.equal(findHandledApplicationStatus('Резюме доставлено'), 'Отклик уже отправлен');
  assert.equal(findHandledApplicationStatus('Вы отказались от этой вакансии'), 'Вы уже отказались от вакансии');
});

test('ignores status words inside vacancy description text', () => {
  assert.equal(findHandledApplicationStatus('В описании сказано: вам отказали ранее'), undefined);
});

test('detects HH employer questionnaire requirement', () => {
  assert.equal(hasApplicationQuestionnaire('Для отклика необходимо ответить на несколько вопросов работодателя'), true);
  assert.equal(hasApplicationQuestionnaire('Отклик отправлен работодателю'), false);
});

test('deduplicates vacancy IDs across hostnames and query parameters', () => {
  const unique = deduplicateVacancies([
    { title: 'First', employer: 'Company', url: '/vacancy/123?hhtmFrom=search' },
    { title: 'Duplicate', employer: 'Company', url: 'https://volgograd.hh.ru/vacancy/123?from=other' },
    { title: 'Second', employer: 'Other', url: '/vacancy/456' },
  ]);

  assert.deepEqual(unique.map((vacancy) => vacancy.url), [
    'https://hh.ru/vacancy/123',
    'https://hh.ru/vacancy/456',
  ]);
});

test('accepts configured on-site city', () => {
  const location = parseVacancyLocation([
    JSON.stringify({
      '@type': 'JobPosting',
      jobLocation: { address: { addressLocality: 'Волжский' } },
      areaServed: { '@type': 'City', name: 'Волгоград' },
    }),
  ]);

  assert.equal(checkLocationEligibility(location, ['Волгоград', 'Волжский']).eligible, true);
});

test('accepts remote work format from escaped HTML source', () => {
  const source = '&#34;workFormats&#34;:[&#34;ON_SITE&#34;,&#34;REMOTE&#34;,&#34;HYBRID&#34;]';
  const location = parseVacancyLocation([], source);

  assert.equal(location.isRemote, true);
  assert.equal(checkLocationEligibility(location, ['Волгоград']).eligible, true);
});

test('accepts remote work format from selected workFormatsElement', () => {
  const source = '&#34;workFormats&#34;:[{&#34;workFormatsElement&#34;:[&#34;REMOTE&#34;]}]';
  const location = parseVacancyLocation([], source);

  assert.equal(location.isRemote, true);
});

test('ignores HH generic work format catalog', () => {
  const source = [
    '&#34;workFormats&#34;:[{&#34;workFormatsElement&#34;:[&#34;ON_SITE&#34;]}]',
    '&#34;workFormats&#34;:[{&#34;id&#34;:&#34;ON_SITE&#34;},{&#34;id&#34;:&#34;REMOTE&#34;},{&#34;id&#34;:&#34;HYBRID&#34;}]',
  ].join(',');
  const location = parseVacancyLocation([], source);

  assert.equal(location.isRemote, false);
});

test('rejects unknown on-site city without remote format', () => {
  const location = { cities: ['Москва'], isRemote: false };

  assert.equal(checkLocationEligibility(location, ['Волгоград', 'Волжский']).eligible, false);
});

test('does not treat remote text in a job description as a remote format', () => {
  const location = parseVacancyLocation([
    JSON.stringify({
      '@type': 'JobPosting',
      jobLocation: { address: { addressLocality: 'Москва' } },
      description: 'В компании есть опыт удаленной работы.',
    }),
  ]);

  assert.equal(location.isRemote, false);
  assert.equal(checkLocationEligibility(location, ['Волгоград']).eligible, false);
});

test('parses excluded terms from CSV', () => {
  assert.deepEqual(parseCsvList('1c, "c++", "quoted, term",\npython'), [
    '1c',
    'c++',
    'quoted, term',
    'python',
  ]);
});

test('matches excluded terms case-insensitively without substring false positives', () => {
  const terms = ['go', 'c++', '.net', 'react'];

  assert.equal(findExcludedTerm('Senior GO developer', terms), 'go');
  assert.equal(findExcludedTerm('C++ developer', terms), 'c++');
  assert.equal(findExcludedTerm('ASP.NET developer', terms), '.net');
  assert.equal(findExcludedTerm('React Native developer', terms), 'react');
  assert.equal(findExcludedTerm('Google Analytics and Golang', terms), undefined);
});

test('saves generated letter with vacancy metadata', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-letters-'));
  const filePath = saveCoverLetter(
    { title: 'PHP / Vue: разработчик?', employer: 'Company', url: 'https://hh.ru/vacancy/123' },
    'Добрый день! Письмо.',
    directory,
  );

  assert.equal(path.basename(filePath), '123-PHP - Vue- разработчик-.md');
  assert.match(fs.readFileSync(filePath, 'utf8'), /Добрый день! Письмо\./);
});

test('removes unavailable website placeholders from generated letter', () => {
  assert.equal(
    cleanCoverLetter('Опыт и кейсы: [ссылка на сайт]\nПортфолио: [YOUR_WEBSITE]'),
    'Опыт и кейсы: \nПортфолио:',
  );
});

test('parses SEMI_AUTO from env', () => {
  const original = process.env.SEMI_AUTO;
  process.env.SEMI_AUTO = 'true';
  try {
    const config = getAutomationConfig();
    assert.equal(config.mode, 'semi');
  } finally {
    if (original === undefined) delete process.env.SEMI_AUTO;
    else process.env.SEMI_AUTO = original;
  }
});

test('parses DRY_RUN from env', () => {
  const original = process.env.DRY_RUN;
  process.env.DRY_RUN = 'true';
  try {
    const config = getAutomationConfig();
    assert.equal(config.dryRun, true);
  } finally {
    if (original === undefined) delete process.env.DRY_RUN;
    else process.env.DRY_RUN = original;
  }
});

test('loads lmstudio preset with localhost default URL', () => {
  const originalProvider = process.env.LLM_PROVIDER;
  const originalKey = process.env.LMSTUDIO_API_KEY;
  process.env.LLM_PROVIDER = 'lmstudio';
  delete process.env.LMSTUDIO_API_KEY;
  try {
    const config = getLlmConfig();
    assert.equal(config.provider, 'lmstudio');
    assert.equal(config.baseURL, 'http://localhost:1234/v1');
    assert.equal(config.apiKey, 'local');
  } finally {
    if (originalProvider === undefined) delete process.env.LLM_PROVIDER;
    else process.env.LLM_PROVIDER = originalProvider;
    if (originalKey === undefined) delete process.env.LMSTUDIO_API_KEY;
    else process.env.LMSTUDIO_API_KEY = originalKey;
  }
});

test('loads ollama preset with localhost default URL', () => {
  const originalProvider = process.env.LLM_PROVIDER;
  process.env.LLM_PROVIDER = 'ollama';
  try {
    const config = getLlmConfig();
    assert.equal(config.provider, 'ollama');
    assert.equal(config.baseURL, 'http://localhost:11434/v1');
    assert.equal(config.apiKey, 'local');
  } finally {
    if (originalProvider === undefined) delete process.env.LLM_PROVIDER;
    else process.env.LLM_PROVIDER = originalProvider;
  }
});

test('loads llamacpp preset with localhost default URL', () => {
  const originalProvider = process.env.LLM_PROVIDER;
  process.env.LLM_PROVIDER = 'llamacpp';
  try {
    const config = getLlmConfig();
    assert.equal(config.provider, 'llamacpp');
    assert.equal(config.baseURL, 'http://localhost:8080/v1');
  } finally {
    if (originalProvider === undefined) delete process.env.LLM_PROVIDER;
    else process.env.LLM_PROVIDER = originalProvider;
  }
});

test('uses LLM sampling defaults that match recommended local settings', () => {
  for (const key of [
    'LLM_CONTEXT_LENGTH',
    'LLM_TEMPERATURE',
    'LLM_TOP_P',
    'LLM_TOP_K',
    'LLM_MIN_P',
    'LLM_REPEAT_PENALTY',
    'LLM_FLASH_ATTENTION',
    'LLM_KEEP_MODEL_LOADED',
  ]) delete process.env[key];

  const sampling = getLlmSampling();
  assert.equal(sampling.contextLength, 16_384);
  assert.equal(sampling.temperature, 0.7);
  assert.equal(sampling.topP, 0.8);
  assert.equal(sampling.topK, 20);
  assert.equal(sampling.minP, 0);
  assert.equal(sampling.repeatPenalty, 1.08);
  assert.equal(sampling.flashAttention, true);
  assert.equal(sampling.keepModelLoaded, true);
});

test('loads resume from config/resume.md', () => {
  const expected = loadResume();
  assert.match(expected, /разработчик/i);
  assert.ok(expected.length > 20);
});
