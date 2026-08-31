import path from 'node:path';
import fs from 'node:fs';
import matter from 'gray-matter';
import { fileConsole } from './logger.js';

const console = fileConsole;

export interface ProfileDoc {
  name: string;
  age: string;
  city: string;
  work_format: string;
  onsite_cities: string[];
  experience_years: string;
  field: string;
  projects_count: string;
  clients: string;
  website: string;
  values: string;
  skills: string[];
  cases: string[];
  body: string;
}

export const CONFIG_DIR = path.resolve(process.cwd(), 'config');
export const PROFILE_FILE = path.join(CONFIG_DIR, 'profile.md');
export const PROFILE_EXAMPLE = path.join(CONFIG_DIR, 'profile.md.example');
export const QUERIES_FILE = path.join(CONFIG_DIR, 'queries.txt');
export const QUERIES_EXAMPLE = path.join(CONFIG_DIR, 'queries.txt.example');
export const EXCLUDED_FILE = path.join(CONFIG_DIR, 'excluded.csv');
export const EXCLUDED_EXAMPLE = path.join(CONFIG_DIR, 'excluded.csv.example');

function ensureRealFile(example: string, target: string, label: string): void {
  if (fs.existsSync(target)) return;
  if (!fs.existsSync(example)) {
    console.error(`\n❌ ${label} не найден (${target}) и шаблона нет (${example}).`);
    process.exit(1);
  }
  console.log(`\n📄 Первый запуск: копирую ${path.basename(example)} → ${path.basename(target)}`);
  fs.copyFileSync(example, target);
  console.log(`   Заполни ${target} и запусти снова.`);
  process.exit(0);
}

export function loadProfile(): ProfileDoc {
  ensureRealFile(PROFILE_EXAMPLE, PROFILE_FILE, 'Профиль');
  const raw = fs.readFileSync(PROFILE_FILE, 'utf-8');
  const { data, content } = matter(raw);
  const d = data as Partial<ProfileDoc>;

  return {
    name: d.name ?? '',
    age: d.age ?? '',
    city: d.city ?? '',
    work_format: d.work_format ?? '',
    onsite_cities: stringList(d.onsite_cities),
    experience_years: d.experience_years ?? '',
    field: d.field ?? '',
    projects_count: d.projects_count ?? '',
    clients: d.clients ?? '',
    website: d.website ?? '',
    values: d.values ?? '',
    skills: Array.isArray(d.skills) ? d.skills : [],
    cases: Array.isArray(d.cases) ? d.cases : [],
    body: content.trim(),
  };
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(String).map((item) => item.trim()).filter(Boolean);
}

export function loadSearchQueries(): string[] {
  ensureRealFile(QUERIES_EXAMPLE, QUERIES_FILE, 'Поисковые запросы');
  const raw = fs.readFileSync(QUERIES_FILE, 'utf-8');
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

export function parseCsvList(raw: string): string[] {
  const values: string[] = [];
  let value = '';
  let quoted = false;

  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (char === '"') {
      if (quoted && raw[i + 1] === '"') {
        value += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (!quoted && (char === ',' || char === '\n' || char === '\r')) {
      const trimmed = value.trim();
      if (trimmed) values.push(trimmed);
      value = '';
    } else {
      value += char;
    }
  }

  const trimmed = value.trim();
  if (trimmed) values.push(trimmed);
  return values;
}

export function loadExcludedText(): string[] {
  ensureRealFile(EXCLUDED_EXAMPLE, EXCLUDED_FILE, 'Исключаемые слова');
  return parseCsvList(fs.readFileSync(EXCLUDED_FILE, 'utf-8'));
}

export function profileHasPlaceholders(p: ProfileDoc): boolean {
  return (
    !p.name ||
    p.name.startsWith('YOUR_') ||
    !p.experience_years ||
    String(p.experience_years).startsWith('YOUR_') ||
    !p.field ||
    p.field.startsWith('YOUR_')
  );
}

export function profileToPromptString(p: ProfileDoc): string {
  // Prefer the human-authored body; fall back to a synthesized summary if body is empty.
  if (p.body && !p.body.includes('YOUR_NAME')) return p.body;

  const skills = p.skills.length ? p.skills.map((s) => `- ${s}`).join('\n') : '- (не заполнено)';
  const cases = p.cases.length ? p.cases.map((c) => `- ${c}`).join('\n') : '- (не заполнено)';

  return [
    `Имя: ${p.name || 'YOUR_NAME'}`,
    `Возраст: ${p.age || 'YOUR_AGE'} лет`,
    `Город: ${p.city || 'YOUR_CITY'}`,
    `Формат работы: ${p.work_format || 'YOUR_WORK_FORMAT'}`,
    '',
    `Опыт: ${p.experience_years || 'YOUR_EXPERIENCE_YEARS'} лет в ${p.field || 'YOUR_FIELD'}, реализовал около ${p.projects_count || 'YOUR_PROJECTS_COUNT'} проектов`,
    '',
    'Ключевые компетенции:',
    skills,
    '',
    'Крутые кейсы:',
    cases,
    '',
    `Работал с: ${p.clients || 'YOUR_CLIENTS'}`,
    '',
    `Сайт/портфолио: ${p.website || 'YOUR_WEBSITE'}`,
    '',
    `Что важно в работе: ${p.values || 'YOUR_VALUES'}`,
  ].join('\n');
}
