import fs from 'node:fs';
import path from 'node:path';
import { inspect } from 'node:util';
import 'dotenv/config';

const configuredLogFile = process.env.LOG_FILE?.trim();
export const LOG_FILE = path.resolve(
  configuredLogFile || path.join(process.cwd(), 'logs', 'auto-apply.log'),
);

function formatArgument(value: unknown): string {
  return typeof value === 'string' ? value : inspect(value, { depth: 5, colors: false });
}

function write(level: string, args: unknown[]): void {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  const message = args.map(formatArgument).join(' ');
  fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} [${level}] ${message}\n`, 'utf8');
}

export const fileConsole = {
  log: (...args: unknown[]) => write('INFO', args),
  error: (...args: unknown[]) => write('ERROR', args),
};
