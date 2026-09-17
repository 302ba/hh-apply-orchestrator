// ABOUTME: Persistent storage of skipped vacancy keys, one per line in config/skipped.txt.
// ABOUTME: Loaded at startup so previously skipped vacancies are auto-skipped on later runs.
import fs from 'node:fs';
import path from 'node:path';

function configDir(): string {
  return process.env.CONFIG_DIR
    ? path.resolve(process.env.CONFIG_DIR)
    : path.resolve(process.cwd(), 'config');
}

function skippedFile(): string {
  return path.join(configDir(), 'skipped.txt');
}

export function loadSkippedKeys(): Set<string> {
  const file = skippedFile();
  if (!fs.existsSync(file)) return new Set();
  const content = fs.readFileSync(file, 'utf8');
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
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(skippedFile(), [...existing].join('\n') + '\n', 'utf8');
}