import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';
import 'dotenv/config';
import { fileConsole } from './logger.js';

const console = fileConsole;

export interface Vacancy {
  title: string;
  url: string;
  employer: string;
}

export type ApplyStatus = 'success' | 'skipped' | 'error';

export interface ApplyResult {
  status: ApplyStatus;
  reason: string;
}

export type LlmProvider = 'openai' | 'openrouter' | 'opencode-go' | 'opencode-zen';

export interface LlmConfig {
  provider: LlmProvider;
  apiKey: string;
  baseURL: string;
  model: string;
}

export type ApplyMode = 'auto' | 'semi';

export interface AutomationConfig {
  maxPages: number;
  delayBetweenAppliesSeconds: number;
  readRetries: number;
  llmRetries: number;
  llmMaxTokens: number;
  mode: ApplyMode;
}

const PROVIDER_PRESETS: Record<LlmProvider, { baseURL: string; defaultModel: string; envKey: string }> = {
  openai: {
    baseURL: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    envKey: 'OPENAI_API_KEY',
  },
  openrouter: {
    baseURL: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-4o-mini',
    envKey: 'OPENROUTER_API_KEY',
  },
  'opencode-go': {
    baseURL: 'https://opencode.ai/zen/go/v1',
    defaultModel: 'qwen3.8-flash',
    envKey: 'OPENCODE_API_KEY',
  },
  'opencode-zen': {
    baseURL: 'https://opencode.ai/zen/v1',
    defaultModel: 'gpt-5.6-luna',
    envKey: 'OPENCODE_API_KEY',
  },
};

function resolveProvider(): LlmProvider {
  const raw = (process.env.LLM_PROVIDER ?? 'openai').toLowerCase();
  if (raw === 'openai' || raw === 'openrouter') return raw;
  if (raw === 'opencode' || raw === 'opencode-go') return 'opencode-go';
  if (raw === 'opencode-zen') return 'opencode-zen';
  console.log(`⚠️  Unknown LLM_PROVIDER "${raw}", falling back to "openai"`);
  return 'openai';
}

export function getLlmConfig(): LlmConfig {
  const provider = resolveProvider();
  const preset = PROVIDER_PRESETS[provider];

  // Provider-specific key wins; OPENAI_API_KEY still works as a fallback for the openai provider.
  const providerSpecific = process.env[preset.envKey];
  const fallback = process.env.OPENAI_API_KEY;
  const apiKey = providerSpecific ?? fallback ?? '';

  const model = process.env.LLM_MODEL ?? preset.defaultModel;
  const baseURL = process.env.LLM_BASE_URL ?? preset.baseURL;

  return { provider, apiKey, baseURL, model };
}

function readNumber(name: string, fallback: number, minimum: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;

  const value = Number(raw);
  if (Number.isInteger(value) && value >= minimum) return value;

  console.log(`⚠️  Invalid ${name}="${raw}", using ${fallback}`);
  return fallback;
}

export function getAutomationConfig(): AutomationConfig {
  return {
    maxPages: readNumber('HH_MAX_PAGES', 1, 1),
    delayBetweenAppliesSeconds: readNumber('HH_DELAY_BETWEEN_APPLIES_SECONDS', 7, 0),
    readRetries: readNumber('HH_READ_RETRIES', 2, 1),
    llmRetries: readNumber('LLM_RETRIES', 2, 1),
    llmMaxTokens: readNumber('LLM_MAX_TOKENS', 1_024, 1),
    mode: readApplyMode(),
  };
}

function readApplyMode(): ApplyMode {
  const raw = (process.env.SEMI_AUTO ?? '').toLowerCase();
  if (raw === 'true' || raw === '1' || raw === 'yes') return 'semi';
  const cliFlag = process.argv.includes('--semi');
  return cliFlag ? 'semi' : 'auto';
}

export const SESSION_DIR = process.env.SESSION_FILES_DIR
  ? process.env.SESSION_FILES_DIR
  : '.session-files';

export const SESSION_FILE = path.join(SESSION_DIR, 'hh_session.json');

export function ensureSessionDir(): void {
  if (!fs.existsSync(SESSION_DIR)) {
    console.log(`Creating session dir: ${SESSION_DIR}`);
    fs.mkdirSync(SESSION_DIR, { recursive: true });
  }
}

export function sessionExists(): boolean {
  return fs.existsSync(SESSION_FILE);
}

export const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? '';
export const OPENCODE_SESSION_HEADER = "x-opencode-session";
export const OPENCODE_SESSION_ID = crypto.randomUUID();
