import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { ICE, InternalCompilerError } from './errors.js';
import { expandHome, isLoopbackUrl, isPlainObject, maskSecret, oneLine } from './util.js';

export interface ShitcConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;

  reasoningParam: string;
  reasoningValue: string;
}

export type ConfigKey = keyof ShitcConfig;
export type ConfigSource = 'default' | 'file' | 'env';

export interface LoadedConfig {
  config: ShitcConfig;
  dir: string;
  path: string;
  exists: boolean;

  sources: Record<ConfigKey, ConfigSource>;
  warnings: string[];
}

export const DEFAULT_CONFIG: ShitcConfig = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  temperature: 0,
  maxTokens: 4096,
  timeoutMs: 120_000,
  reasoningParam: '',
  reasoningValue: '',
};

const RESERVED_BODY_FIELDS: ReadonlySet<string> = new Set([
  'model',
  'messages',
  'temperature',
  'top_p',
  'n',
  'stream',
  'stream_options',
  'max_tokens',
  'max_completion_tokens',
  'response_format',
  'stop',
  'presence_penalty',
  'frequency_penalty',
  'logprobs',
  'top_logprobs',
  'tools',
  'tool_choice',
  'functions',
  'function_call',
  'parallel_tool_calls',
  'user',
  'seed',
]);

const KEY_ALIASES = new Map<string, ConfigKey>([
  ['baseurl', 'baseUrl'],
  ['base-url', 'baseUrl'],
  ['base_url', 'baseUrl'],
  ['url', 'baseUrl'],
  ['apikey', 'apiKey'],
  ['api-key', 'apiKey'],
  ['api_key', 'apiKey'],
  ['key', 'apiKey'],
  ['token', 'apiKey'],
  ['model', 'model'],
  ['temperature', 'temperature'],
  ['temp', 'temperature'],
  ['maxtokens', 'maxTokens'],
  ['max-tokens', 'maxTokens'],
  ['max_tokens', 'maxTokens'],
  ['timeout', 'timeoutMs'],
  ['timeoutms', 'timeoutMs'],
  ['timeout-ms', 'timeoutMs'],
  ['reasoning', 'reasoningParam'],
  ['reasoningparam', 'reasoningParam'],
  ['reasoning-param', 'reasoningParam'],
  ['reasoning_param', 'reasoningParam'],
  ['reasoningeffort', 'reasoningParam'],
  ['reasoning-effort', 'reasoningParam'],
  ['cot', 'reasoningParam'],
  ['cot-param', 'reasoningParam'],
  ['cotparam', 'reasoningParam'],
  ['reasoningvalue', 'reasoningValue'],
  ['reasoning-value', 'reasoningValue'],
  ['reasoning_value', 'reasoningValue'],
  ['reasoninglevel', 'reasoningValue'],
  ['reasoning-level', 'reasoningValue'],
  ['cot-value', 'reasoningValue'],
  ['cotvalue', 'reasoningValue'],
]);

const NUMBER_KEYS: ReadonlySet<ConfigKey> = new Set<ConfigKey>(['temperature', 'maxTokens', 'timeoutMs']);

export function normalizeKey(raw: string): ConfigKey | null {
  const key = raw.trim();
  if (!key) return null;
  return KEY_ALIASES.get(key.toLowerCase()) ?? null;
}

export function configDir(): string {
  const override = process.env.SHITC_CONFIG_DIR;
  if (override && override.trim()) return path.resolve(expandHome(override.trim()));
  return path.join(homedir(), '.shitc');
}

export function configPath(): string {
  return path.join(configDir(), 'config.json');
}

export function outputRoot(): string {
  const override = process.env.SHITC_OUT_DIR ?? process.env.SHITC_ARTIFACT_DIR;
  if (override && override.trim()) return path.resolve(expandHome(override.trim()));
  return path.join(configDir(), 'build');
}

export function ensureDir(dir: string, mode = 0o700): string {
  try {
    mkdirSync(dir, { recursive: true, mode });

    try {
      const stat = statSync(dir);
      if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) chmodSync(dir, mode);
    } catch {

    }
    return dir;
  } catch (cause) {
    throw new InternalCompilerError(ICE.CONFIG, `cannot create config directory ${dir}`, {
      hint: 'check permissions or set SHITC_CONFIG_DIR to a writable path',
      cause,
    });
  }
}

function readRawFile(): Record<string, unknown> | null {
  const file = configPath();
  if (!existsSync(file)) return null;

  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (cause) {
    throw new InternalCompilerError(ICE.CONFIG, `cannot read ${file}`, {
      hint: 'check file permissions; delete the file to regenerate it',
      cause,
    });
  }

  if (!text.trim()) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new InternalCompilerError(ICE.CONFIG, `${file} is not valid JSON`, {
      hint: `fix the file, or delete it and run "shitc init"`,
      detail: oneLine(text, 200),
      cause,
    });
  }

  if (!isPlainObject(parsed)) {
    throw new InternalCompilerError(ICE.CONFIG, `${file} must contain a JSON object`, {
      hint: 'delete the file and run "shitc init"',
    });
  }

  const normalized: Record<string, unknown> = {};
  for (const [rawKey, value] of Object.entries(parsed)) {
    const key = normalizeKey(rawKey);
    if (key) normalized[key] = value;
    else normalized[rawKey] = value; 
  }
  return normalized;
}

export interface LoadConfigOptions {

  env?: boolean;
}

export function loadConfig(options: LoadConfigOptions = {}): LoadedConfig {
  const useEnv = options.env !== false;
  const raw = readRawFile();
  const config: ShitcConfig = { ...DEFAULT_CONFIG };
  const sources: Record<ConfigKey, ConfigSource> = {
    baseUrl: 'default',
    apiKey: 'default',
    model: 'default',
    temperature: 'default',
    maxTokens: 'default',
    timeoutMs: 'default',
    reasoningParam: 'default',
    reasoningValue: 'default',
  };
  const warnings: string[] = [];

  if (raw) {
    for (const key of Object.keys(sources) as ConfigKey[]) {
      if (!(key in raw)) continue;
      const coerced = coerceValue(key, raw[key], warnings);
      if (coerced !== undefined) {
        assignField(config, key, coerced);
        sources[key] = 'file';
      }
    }
  }

  if (useEnv) {
    const envMap: Array<[ConfigKey, string[]]> = [
      ['baseUrl', ['SHITC_BASE_URL', 'OPENAI_BASE_URL']],
      ['apiKey', ['SHITC_API_KEY', 'OPENAI_API_KEY']],
      ['model', ['SHITC_MODEL', 'OPENAI_MODEL']],
      ['temperature', ['SHITC_TEMPERATURE']],
      ['maxTokens', ['SHITC_MAX_TOKENS']],
      ['timeoutMs', ['SHITC_TIMEOUT_MS']],
      ['reasoningParam', ['SHITC_REASONING_PARAM']],
      ['reasoningValue', ['SHITC_REASONING_VALUE']],
    ];
    for (const [key, names] of envMap) {
      for (const name of names) {
        const value = process.env[name];
        if (value === undefined || value.trim() === '') continue;
        const coerced = coerceValue(key, value, warnings);
        if (coerced !== undefined) {
          assignField(config, key, coerced);
          sources[key] = 'env';
        }
        break;
      }
    }

    const combined = process.env.SHITC_REASONING?.trim();
    if (combined) {
      const equals = combined.indexOf('=');
      if (equals > 0) {
        config.reasoningParam = combined.slice(0, equals).trim();
        config.reasoningValue = combined.slice(equals + 1).trim();
        sources.reasoningParam = 'env';
        sources.reasoningValue = 'env';
      } else {
        warnings.push('ignoring SHITC_REASONING without "param=value"');
      }
    }
  }

  config.baseUrl = normalizeBaseUrl(config.baseUrl);

  return { config, dir: configDir(), path: configPath(), exists: raw !== null, sources, warnings };
}

function assignField(config: ShitcConfig, key: ConfigKey, value: string | number): void {
  (config as unknown as Record<ConfigKey, string | number>)[key] = value;
}

export function coerceValue(key: ConfigKey, value: unknown, warnings: string[] = []): string | number | undefined {
  if (key === 'temperature' || key === 'maxTokens' || key === 'timeoutMs') {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    warnings.push(`ignoring non-numeric value for ${key}: ${oneLine(String(value), 40)}`);
    return undefined;
  }
  if (typeof value === 'string') return value.trim();
  if (value === null || value === undefined) return undefined;
  warnings.push(`ignoring non-string value for ${key}: ${oneLine(String(value), 40)}`);
  return undefined;
}

export function normalizeBaseUrl(raw: string): string {
  let value = raw.trim();
  if (!value) return DEFAULT_CONFIG.baseUrl;
  value = value.replace(/\/+$/, '');
  try {
    const url = new URL(value);
    if (url.pathname === '/' || url.pathname === '') {
      return `${url.origin}/v1`;
    }
    return value;
  } catch {
    return value;
  }
}

export interface ConfigIssue {
  field: ConfigKey | 'apiKeyMissing';
  message: string;
  hint: string;
}

export function inspectConfig(config: ShitcConfig, options: { requireApiKey?: boolean } = {}): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const requireApiKey = options.requireApiKey ?? true;

  try {
    const url = new URL(config.baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      issues.push({
        field: 'baseUrl',
        message: `unsupported protocol "${url.protocol}"`,
        hint: 'baseUrl must be an http(s) URL, e.g. https://api.openai.com/v1',
      });
    }
  } catch {
    issues.push({
      field: 'baseUrl',
      message: `"${oneLine(config.baseUrl, 80)}" is not a valid URL`,
      hint: 'example: https://api.openai.com/v1',
    });
  }

  if (!config.model.trim()) {
    issues.push({ field: 'model', message: 'model is empty', hint: 'shitc config set model gpt-4o-mini' });
  }
  if (!Number.isFinite(config.temperature) || config.temperature < 0 || config.temperature > 2) {
    issues.push({ field: 'temperature', message: `${config.temperature} is out of range`, hint: 'use a number in [0, 2]' });
  }
  if (!Number.isInteger(config.maxTokens) || config.maxTokens < 16 || config.maxTokens > 1_000_000) {
    issues.push({ field: 'maxTokens', message: `${config.maxTokens} is out of range`, hint: 'use an integer in [16, 1000000]' });
  }
  if (!Number.isFinite(config.timeoutMs) || config.timeoutMs < 1000) {
    issues.push({ field: 'timeoutMs', message: `${config.timeoutMs} is too small`, hint: 'use milliseconds, e.g. 120000' });
  }

  const reasoningParam = config.reasoningParam.trim();
  const reasoningValue = config.reasoningValue.trim();
  if (reasoningParam) {
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(reasoningParam)) {
      issues.push({
        field: 'reasoningParam',
        message: `"${oneLine(reasoningParam, 60)}" is not a valid parameter name`,
        hint: 'use letters/digits/underscore, e.g. reasoning_effort',
      });
    } else if (RESERVED_BODY_FIELDS.has(reasoningParam.toLowerCase())) {
      issues.push({
        field: 'reasoningParam',
        message: `"${reasoningParam}" is a reserved request field`,
        hint: 'use the provider-specific reasoning parameter, e.g. reasoning_effort or enable_thinking',
      });
    }

  } else if (reasoningValue) {
    issues.push({
      field: 'reasoningParam',
      message: 'reasoningValue is set but reasoningParam is empty',
      hint: 'set the parameter name too, or clear reasoningValue',
    });
  }

  if (requireApiKey && !config.apiKey.trim() && !isLoopbackUrl(config.baseUrl)) {
    issues.push({
      field: 'apiKeyMissing',
      message: 'no API key configured',
      hint: 'run "shitc init", or export SHITC_API_KEY / OPENAI_API_KEY',
    });
  }

  return issues;
}

export function assertConfigured(config: ShitcConfig, requireApiKey = true): void {
  const issues = inspectConfig(config, { requireApiKey });
  const blocking = issues.find(
    (issue) => issue.field !== 'apiKeyMissing' || requireApiKey,
  );
  if (!blocking) return;

  throw new InternalCompilerError(ICE.CONFIG, `invalid compiler configuration: ${blocking.message}`, {
    hint: blocking.hint,
    detail: issues.length > 1 ? issues.slice(1).map((issue) => `- ${issue.message}: ${issue.hint}`).join('\n') : undefined,
  });
}

export interface SaveConfigResult {
  path: string;
  config: ShitcConfig;
}

export function saveConfig(patch: Partial<ShitcConfig>): SaveConfigResult {
  const dir = ensureDir(configDir());
  const raw = readRawFile() ?? {};

  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    raw[key] = value;
  }

  const merged: ShitcConfig = { ...DEFAULT_CONFIG };
  const warnings: string[] = [];
  for (const key of Object.keys(merged) as ConfigKey[]) {
    if (key in raw) {
      const coerced = coerceValue(key, raw[key], warnings);
      if (coerced !== undefined) assignField(merged, key, coerced);
    }
  }
  merged.baseUrl = normalizeBaseUrl(merged.baseUrl);

  const issues = inspectConfig(merged, { requireApiKey: false });
  if (issues.length > 0) {
    const first = issues[0]!;
    throw new InternalCompilerError(ICE.CONFIG, `refusing to save invalid config: ${first.message}`, {
      hint: first.hint,
    });
  }

  const file = configPath();
  try {
    writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
    if (process.platform !== 'win32') chmodSync(file, 0o600);
  } catch (cause) {
    throw new InternalCompilerError(ICE.CONFIG, `cannot write ${file}`, {
      hint: 'check permissions on the config directory',
      cause,
    });
  }

  return { path: file, config: merged };
}

export function parseConfigAssignment(rawKey: string, rawValue: string): { key: ConfigKey; value: string | number } {
  const key = normalizeKey(rawKey);
  if (!key) {
    throw new InternalCompilerError(ICE.CONFIG, `unknown config key "${rawKey}"`, {
      hint: 'known keys: baseUrl, apiKey, model, temperature, maxTokens, timeoutMs',
    });
  }

  if (NUMBER_KEYS.has(key)) {
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed)) {
      throw new InternalCompilerError(ICE.CONFIG, `${key} expects a number, got "${rawValue}"`, {
        hint: key === 'timeoutMs' ? 'milliseconds, e.g. 120000' : undefined,
      });
    }
    return { key, value: parsed };
  }

  if (!rawValue.trim() && key !== 'apiKey') {
    throw new InternalCompilerError(ICE.CONFIG, `${key} cannot be empty`);
  }
  return { key, value: rawValue.trim() };
}

export interface ConfigRow {
  key: string;
  value: string;
  source: ConfigSource;
}

export function describeConfig(loaded: LoadedConfig): ConfigRow[] {
  const { config, sources } = loaded;
  return [
    { key: 'baseUrl', value: config.baseUrl, source: sources.baseUrl },
    { key: 'apiKey', value: maskSecret(config.apiKey), source: sources.apiKey },
    { key: 'model', value: config.model, source: sources.model },
    { key: 'temperature', value: String(config.temperature), source: sources.temperature },
    { key: 'maxTokens', value: String(config.maxTokens), source: sources.maxTokens },
    { key: 'timeoutMs', value: String(config.timeoutMs), source: sources.timeoutMs },
    {
      key: 'reasoningParam',
      value: config.reasoningParam ? `${config.reasoningParam} = ${config.reasoningValue}` : '(none)',
      source: sources.reasoningParam,
    },
  ];
}
