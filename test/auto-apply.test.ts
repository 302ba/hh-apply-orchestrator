import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSearchUrl,
  deduplicateVacancies,
  findHandledApplicationStatus,
  normalizeVacancyUrl,
} from '../src/auto-apply.ts';
import { parseCsvList } from '../src/config-loader.ts';
import { findExcludedTerm } from '../src/exclusions.ts';
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
});

test('ignores status words inside vacancy description text', () => {
  assert.equal(findHandledApplicationStatus('В описании сказано: вам отказали ранее'), undefined);
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
