import fs from 'node:fs';
import path from 'node:path';
import 'dotenv/config';
import type { Vacancy } from './config.js';

export const LETTERS_DIR = path.resolve(
  process.env.LETTERS_DIR?.trim() || path.join(process.cwd(), 'letters'),
);

function vacancyId(url: string): string | undefined {
  return new URL(url, 'https://hh.ru').pathname.match(/\/vacancy\/(\d+)/)?.[1];
}

function safeFilenamePart(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

export function coverLetterFilename(vacancy: Vacancy): string {
  const id = vacancyId(vacancy.url);
  const title = safeFilenamePart(vacancy.title) || 'vacancy';
  return `${id ? `${id}-` : ''}${title}.md`;
}

export function saveCoverLetter(vacancy: Vacancy, letter: string, directory = LETTERS_DIR): string {
  fs.mkdirSync(directory, { recursive: true });
  const filePath = path.join(directory, coverLetterFilename(vacancy));
  const content = [
    `# ${vacancy.title}`,
    '',
    `- Компания: ${vacancy.employer}`,
    `- Ссылка: ${vacancy.url}`,
    '',
    '---',
    '',
    letter.trim(),
    '',
  ].join('\n');
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}
