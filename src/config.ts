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

export type LlmProvider = 'openai' | 'openrouter' | 'opencode-go' | 'opencode-zen' | 'lmstudio' | 'ollama' | 'llamacpp';

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
  dryRun: boolean;
}

const PROVIDER_PRESETS: Record<LlmProvider, { baseURL: string; defaultModel: string; envKey: string; requiresKey: boolean }> = {
  openai: {
    baseURL: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    envKey: 'OPENAI_API_KEY',
    requiresKey: true,
  },
  openrouter: {
    baseURL: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-4o-mini',
    envKey: 'OPENROUTER_API_KEY',
    requiresKey: true,
  },
  'opencode-go': {
    baseURL: 'https://opencode.ai/zen/go/v1',
    defaultModel: 'qwen3.8-flash',
    envKey: 'OPENCODE_API_KEY',
    requiresKey: true,
  },
  'opencode-zen': {
    baseURL: 'https://opencode.ai/zen/v1',
    defaultModel: 'gpt-5.6-luna',
    envKey: 'OPENCODE_API_KEY',
    requiresKey: true,
  },
  lmstudio: {
    baseURL: 'http://localhost:1234/v1',
    defaultModel: 'local-model',
    envKey: 'LMSTUDIO_API_KEY',
    requiresKey: false,
  },
  ollama: {
    baseURL: 'http://localhost:11434/v1',
    defaultModel: 'llama3.1',
    envKey: 'OLLAMA_API_KEY',
    requiresKey: false,
  },
  llamacpp: {
    baseURL: 'http://localhost:8080/v1',
    defaultModel: 'local-model',
    envKey: 'LLAMACPP_API_KEY',
    requiresKey: false,
  },
};

function resolveProvider(): LlmProvider {
  const raw = (process.env.LLM_PROVIDER ?? 'openai').toLowerCase();
  if (raw === 'openai' || raw === 'openrouter') return raw;
  if (raw === 'opencode' || raw === 'opencode-go') return 'opencode-go';
  if (raw === 'opencode-zen') return 'opencode-zen';
  if (raw === 'lmstudio' || raw === 'lm-studio') return 'lmstudio';
  if (raw === 'ollama') return 'ollama';
  if (raw === 'llama.cpp' || raw === 'llama-cpp' || raw === 'llamacpp') return 'llamacpp';
  console.log(`⚠️  Unknown LLM_PROVIDER "${raw}", falling back to "openai"`);
  return 'openai';
}

export interface LlmSampling {
  contextLength: number;
  temperature: number;
  topP: number;
  topK: number;
  minP: number;
  repeatPenalty: number;
  flashAttention: boolean;
  keepModelLoaded: boolean;
}

export function getLlmConfig(): LlmConfig {
  const provider = resolveProvider();
  const preset = PROVIDER_PRESETS[provider];

  // Provider-specific key wins. For openai/openrouter, OPENAI_API_KEY is a real fallback.
  // For local providers, a synthetic placeholder is enough unless the env supplies a real one.
  const providerSpecific = process.env[preset.envKey];
  const fallback = provider === 'openai' ? (process.env.OPENAI_API_KEY ?? '') : '';
  let apiKey = providerSpecific ?? fallback ?? '';
  if (!apiKey && !preset.requiresKey) apiKey = 'local';

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

function readFloat(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;

  const value = Number(raw);
  if (Number.isFinite(value) && value >= minimum && value <= maximum) return value;

  console.log(`⚠️  Invalid ${name}="${raw}", using ${fallback}`);
  return fallback;
}

function readBoolean(name: string, fallback: boolean): boolean {
  const raw = (process.env[name] ?? '').toLowerCase();
  if (raw === '') return fallback;
  if (['true', '1', 'yes', 'on'].includes(raw)) return true;
  if (['false', '0', 'no', 'off'].includes(raw)) return false;
  console.log(`⚠️  Invalid ${name}="${raw}", using ${fallback}`);
  return fallback;
}

export function getLlmSampling(): LlmSampling {
  return {
    contextLength: readNumber('LLM_CONTEXT_LENGTH', 16_384, 256),
    temperature: readFloat('LLM_TEMPERATURE', 0.7, 0, 2),
    topP: readFloat('LLM_TOP_P', 0.8, 0, 1),
    topK: readNumber('LLM_TOP_K', 20, 0),
    minP: readFloat('LLM_MIN_P', 0, 0, 1),
    repeatPenalty: readFloat('LLM_REPEAT_PENALTY', 1.08, 0, 2),
    flashAttention: readBoolean('LLM_FLASH_ATTENTION', true),
    keepModelLoaded: readBoolean('LLM_KEEP_MODEL_LOADED', true),
  };
}

export function getAutomationConfig(): AutomationConfig {
  return {
    maxPages: readNumber('HH_MAX_PAGES', 1, 1),
    delayBetweenAppliesSeconds: readNumber('HH_DELAY_BETWEEN_APPLIES_SECONDS', 7, 0),
    readRetries: readNumber('HH_READ_RETRIES', 2, 1),
    llmRetries: readNumber('LLM_RETRIES', 2, 1),
    llmMaxTokens: readNumber('LLM_MAX_TOKENS', 1_024, 1),
    mode: readApplyMode(),
    dryRun: readDryRun(),
  };
}

function readDryRun(): boolean {
  const raw = (process.env.DRY_RUN ?? '').toLowerCase();
  if (raw === 'true' || raw === '1' || raw === 'yes') return true;
  return process.argv.includes('--dry');
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
