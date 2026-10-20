import process from 'node:process';
import { assertConfigured, loadConfig, saveConfig, type ShitcConfig } from './config.js';
import { ICE, InternalCompilerError, UsageError } from './errors.js';
import { ask, canPrompt } from './tty.js';
import { color, symbol } from './ui.js';
import { formatDuration, oneLine } from './util.js';

export interface FetchModelsOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function fetchModels(config: ShitcConfig, options: FetchModelsOptions = {}): Promise<string[]> {
  const timeoutMs = options.timeoutMs ?? 12_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  const onExternalAbort = (): void => controller.abort();
  options.signal?.addEventListener('abort', onExternalAbort, { once: true });

  const startedAt = Date.now();
  try {
    const headers: Record<string, string> = { accept: 'application/json', 'user-agent': 'shitc' };
    if (config.apiKey.trim()) headers.authorization = `Bearer ${config.apiKey.trim()}`;

    const response = await fetch(`${config.baseUrl}/models`, { headers, signal: controller.signal });
    const elapsed = formatDuration(Date.now() - startedAt);

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new InternalCompilerError(ICE.REQUEST, `listing models failed (HTTP ${response.status})`, {
        hint:
          response.status === 401 || response.status === 403
            ? 'check the API key ("shitc config set apiKey sk-...")'
            : response.status === 404
              ? `this endpoint does not implement GET /models; enter the model name manually`
              : 'the endpoint rejected the request; check baseUrl and the API key',
        detail: oneLine(body, 300),
      });
    }

    const payload: unknown = await response.json();
    const models = [...new Set(extractModelIds(payload))].sort((a, b) => a.localeCompare(b));
    if (models.length === 0) {
      throw new InternalCompilerError(ICE.RESPONSE, 'the endpoint returned no models', {
        hint: 'enter the model name manually ("shitc config set model ...")',
      });
    }
    return models;
  } catch (cause) {
    if (cause instanceof InternalCompilerError) throw cause;
    if (controller.signal.aborted) {
      throw new InternalCompilerError(ICE.REQUEST, `listing models timed out after ${timeoutMs}ms`, {
        hint: 'check the endpoint, or pass a longer --timeout',
        cause,
      });
    }
    throw new InternalCompilerError(ICE.REQUEST, `cannot reach ${hostOf(config.baseUrl)} to list models`, {
      hint: 'check network/proxy, or pass a different --base-url',
      cause,
    });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onExternalAbort);
  }
}

function extractModelIds(payload: unknown, depth = 0): string[] {
  if (depth > 2) return [];
  if (Array.isArray(payload)) {
    const ids: string[] = [];
    for (const item of payload) {
      if (typeof item === 'string' && item.trim()) ids.push(item.trim());
      else if (isRecord(item) && typeof item.id === 'string' && item.id.trim()) ids.push(item.id.trim());
      else if (isRecord(item) && typeof item.name === 'string' && item.name.trim()) ids.push(item.name.trim());
    }
    return ids;
  }
  if (isRecord(payload)) {
    for (const key of ['data', 'models', 'items', 'result']) {
      if (key in payload) {
        const ids = extractModelIds(payload[key], depth + 1);
        if (ids.length > 0) return ids;
      }
    }
  }
  return [];
}

export function formatModelList(models: string[], current?: string): string[] {
  const width = String(models.length).length;
  return models.map((model, index) => {
    const marker = current && model === current ? ` ${color.green('*')}` : '';
    return `  ${color.dim(String(index + 1).padStart(width))}  ${model}${marker}`;
  });
}

export function resolveModelSelection(input: string, models: string[]): string | null {
  const raw = input.trim();
  if (!raw) return null;

  const numeric = raw.match(/^#?(\d{1,4})$/);
  if (numeric) {
    const index = Number(numeric[1]);
    if (index >= 1 && index <= models.length) return models[index - 1] ?? null;
    return null;
  }

  for (const model of models) if (model === raw) return model;

  const lower = raw.toLowerCase();
  const insensitive = models.filter((model) => model.toLowerCase() === lower);
  if (insensitive.length === 1) return insensitive[0]!;

  const prefixed = models.filter((model) => model.toLowerCase().startsWith(lower));
  if (prefixed.length === 1) return prefixed[0]!;

  return null;
}

export interface ModelsCommandOptions {

  selector?: string;
  json?: boolean;
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function runModelsCommand(options: ModelsCommandOptions = {}): Promise<number> {
  const loaded = loadConfig();
  const config: ShitcConfig = {
    ...loaded.config,
    baseUrl: options.baseUrl?.trim() || loaded.config.baseUrl,
    apiKey: options.apiKey !== undefined ? options.apiKey.trim() : loaded.config.apiKey,
    timeoutMs: options.timeoutMs ?? loaded.config.timeoutMs,
  };
  assertConfigured(config);

  process.stderr.write(
    options.json ? '' : `${color.dim('endpoint')} ${config.baseUrl} ${color.dim('· listing models…')}\n`,
  );
  const models = await fetchModels(config, { timeoutMs: options.timeoutMs, signal: options.signal });

  if (options.selector) {
    const chosen = resolveModelSelection(options.selector, models);
    if (!chosen) {
      throw new UsageError(`"${options.selector}" is not one of the ${models.length} models`, {
        hint: `pick a number 1-${models.length} (e.g. '#6') or an exact model name`,
      });
    }
    const saved = saveConfig({ model: chosen });
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ ok: true, selected: chosen, path: saved.path, models }, null, 2)}\n`);
    } else {
      process.stdout.write(`${color.green(symbol.ok)} model = ${chosen} ${color.dim(`(${saved.path})`)}\n`);
    }
    return 0;
  }

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        { ok: true, baseUrl: config.baseUrl, current: config.model, count: models.length, models, path: loaded.path },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  process.stdout.write(`${color.dim('endpoint')} ${config.baseUrl}\n`);
  for (const line of formatModelList(models, config.model)) process.stdout.write(`${line}\n`);
  process.stdout.write(`${color.dim(`${models.length} model(s) · current: ${config.model}`)}\n`);

  if (!canPrompt()) {
    process.stdout.write(`${color.dim(`select one with: ${'shitc models'} '#6'`)}\n`);
    return 0;
  }

  const answer = await ask(`Select model [#n or name, Enter to keep ${config.model}]`);
  if (!answer) {
    process.stdout.write(`${color.dim('unchanged')}\n`);
    return 0;
  }

  const chosen = resolveModelSelection(answer, models);
  if (!chosen) {
    throw new UsageError(`"${answer}" is not one of the ${models.length} models`, {
      hint: `pick a number 1-${models.length} (e.g. '#6') or an exact model name`,
    });
  }

  const saved = saveConfig({ model: chosen });
  process.stdout.write(`${color.green(symbol.ok)} model = ${chosen} ${color.dim(`(${saved.path})`)}\n`);
  return 0;
}

export async function pickModelInteractive(config: ShitcConfig, fallback: string): Promise<string> {
  let models: string[] = [];
  try {
    models = await fetchModels(config, { timeoutMs: 12_000 });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    process.stderr.write(`${color.yellow(symbol.warn)} could not list models (${oneLine(message, 120)})\n`);
    return ask('Model', fallback);
  }

  process.stderr.write(`\n${color.dim(`models served by ${config.baseUrl}`)}\n`);
  for (const line of formatModelList(models, config.model)) process.stderr.write(`${line}\n`);

  const answer = await ask(`Model [#n for the nth model, or a name]`, models.includes(fallback) ? fallback : undefined);
  if (!answer) return fallback;

  const chosen = resolveModelSelection(answer, models);
  if (chosen) return chosen;

  process.stderr.write(`${color.yellow(symbol.warn)} "${answer}" is not in the list; using it as-is\n`);
  return answer;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
