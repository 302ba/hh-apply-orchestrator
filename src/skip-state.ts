// ABOUTME: Persistent storage of skipped vacancy keys, one per line in config/skipped.txt.
// ABOUTME: Loaded at startup so previously skipped vacancies are auto-skipped on later runs.
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from './config-loader.js';

export const SKIPPED_FILE = path.join(CONFIG_DIR, 'skipped.txt');

export function loadSkippedKeys(): Set<string> {
  if (!fs.existsSync(SKIPPED_FILE)) return new Set();
  const content = fs.readFileSync(SKIPPED_FILE, 'utf8');
  const keys = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    const key = line.trim();
    if (key) keys.add(key);
  }
  return keys;
}

export function addSkippedKey(key: string): void {
  const existing = loadSkippedKeys();
  if (existing.has(key)) return;
  existing.add(key);
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(SKIPPED_FILE, [...existing].join('\n') + '\n', 'utf8');
}