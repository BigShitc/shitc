import process from 'node:process';
import { DEFAULT_CONFIG, configDir, configPath, loadConfig, normalizeBaseUrl, saveConfig } from './config.js';
import { UsageError } from './errors.js';
import { pickModelInteractive } from './models.js';
import { canPrompt, ask, askSecret, choose, confirm } from './tty.js';
import { color, symbol } from './ui.js';
import { isLoopbackUrl, maskSecret } from './util.js';
import { PROGRAM, VERSION } from './version.js';

export interface InitOptions {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;

  reasoning?: string;
  force?: boolean;
  json?: boolean;
}

interface Preset {
  name: string;
  baseUrl: string;
  model: string;
  note: string;
}

const PRESETS: Preset[] = [
  { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', note: 'API key required' },
  { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', note: 'API key required' },
  { name: 'Moonshot Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', note: 'API key required' },
  { name: 'Zhipu GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash', note: 'API key required' },
  { name: 'Aliyun DashScope', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', note: 'API key required' },
  { name: 'Volcengine Ark', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-1.5-pro-32k', note: 'API key required' },
  { name: 'SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct', note: 'API key required' },
  { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini', note: 'API key required' },
  { name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', note: 'API key required' },
  { name: 'Ollama (local)', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5-coder:7b', note: 'no key needed' },
  { name: 'LM Studio (local)', baseUrl: 'http://127.0.0.1:1234/v1', model: 'local-model', note: 'no key needed' },
  { name: 'Custom', baseUrl: '', model: '', note: 'any OpenAI-compatible /chat/completions endpoint' },
];

export async function runInit(options: InitOptions): Promise<number> {
  const existing = loadConfig();
  const existingConfig = existing.exists ? existing.config : null;
  const interactive = !options.baseUrl && !options.apiKey && !options.model;

  if (interactive && !canPrompt()) {
    throw new UsageError('shitc init needs a terminal, or pass flags', {
      hint: 'shitc init --base-url https://api.openai.com/v1 --api-key sk-... --model gpt-4o-mini',
    });
  }

  if (existing.exists && !options.force && !interactive) {
    throw new UsageError(`config already exists at ${existing.path}`, {
      hint: 'pass --force to overwrite it',
    });
  }

  if (!options.json) {
    process.stderr.write(`${color.bold(`${PROGRAM} ${VERSION}`)} ${color.dim('configure')}\n`);
    process.stderr.write(`config directory: ${color.dim(existing.dir)}\n`);
    if (existingConfig) {
      process.stderr.write(
        `existing config: ${color.dim(existing.path)} ${color.dim(`(apiKey ${maskSecret(existingConfig.apiKey)})`)}\n`,
      );
    }
    process.stderr.write('\n');
  }

  let baseUrl = options.baseUrl?.trim() ?? '';
  let apiKey = options.apiKey?.trim() ?? '';
  let model = options.model?.trim() ?? '';
  let temperature = options.temperature ?? DEFAULT_CONFIG.temperature;
  let maxTokens = options.maxTokens ?? DEFAULT_CONFIG.maxTokens;
  let reasoningParam = existingConfig?.reasoningParam ?? '';
  let reasoningValue = existingConfig?.reasoningValue ?? '';

  if (options.reasoning !== undefined) {
    const parsed = parseReasoningFlag(options.reasoning);
    reasoningParam = parsed.param;
    reasoningValue = parsed.value;
  }

  if (interactive) {
    const presetIndex = await choose(
      'Provider preset (number)',
      PRESETS.map(
        (preset, index) =>
          `${String(index + 1).padStart(2)}. ${preset.name.padEnd(18)} ${(preset.baseUrl || '-').padEnd(56)} ${preset.model || '-'}  ${preset.note}`,
      ),
      guessPresetIndex(existingConfig?.baseUrl),
    );
    const preset = PRESETS[presetIndex] ?? PRESETS[0]!;

    baseUrl = await ask('Base URL', preset.baseUrl || existingConfig?.baseUrl || DEFAULT_CONFIG.baseUrl);
    baseUrl = normalizeBaseUrl(baseUrl);

    const keyDefault = existingConfig?.apiKey ?? '';
    if (keyDefault) {
      process.stderr.write(`API key ${color.dim(`(stored: ${maskSecret(keyDefault)})`)} — press Enter to keep it\n`);
    }
    const keyAnswer = await askSecret('API key (hidden, Enter to keep/skip): ');
    apiKey = keyAnswer.trim() || keyDefault;

    const modelFallback = preset.model || existingConfig?.model || DEFAULT_CONFIG.model;
    model = await pickModelInteractive(
      { ...DEFAULT_CONFIG, baseUrl, apiKey, model: modelFallback },
      modelFallback,
    );

    const temperatureAnswer = await ask('Temperature', String(existingConfig?.temperature ?? DEFAULT_CONFIG.temperature));
    const parsedTemperature = Number(temperatureAnswer);
    if (Number.isFinite(parsedTemperature)) temperature = parsedTemperature;

    const maxTokensAnswer = await ask('Max output tokens', String(existingConfig?.maxTokens ?? DEFAULT_CONFIG.maxTokens));
    const parsedMaxTokens = Number.parseInt(maxTokensAnswer, 10);
    if (Number.isFinite(parsedMaxTokens)) maxTokens = parsedMaxTokens;

    if (options.reasoning === undefined) {
      const paramDefault = existingConfig?.reasoningParam ?? '';
      const paramAnswer = (
        await ask('Reasoning/CoT parameter (Enter = not supported, e.g. reasoning_effort)', paramDefault)
      ).trim();
      reasoningParam = paramAnswer;
      if (reasoningParam) {
        const valueAnswer = (
          await ask(`  ${reasoningParam} value (low/medium/high/max, true, ...)`, reasoningValue || 'medium')
        ).trim();
        reasoningValue = valueAnswer || 'medium';
      } else {
        reasoningValue = '';
      }
    }

    process.stderr.write('\n');
    const reasoningNote = reasoningParam ? `  ${color.dim('·')}  reasoning ${reasoningParam}=${reasoningValue}` : '';
    process.stderr.write(
      `${color.dim('target')}  ${baseUrl}  ${color.dim('·')}  ${model}  ${color.dim('·')}  apiKey ${maskSecret(apiKey)}${reasoningNote}\n`,
    );
    const shouldWrite = await confirm(`Write ${configPath()}?`, true);
    if (!shouldWrite) {
      process.stderr.write(`${color.yellow(symbol.warn)} aborted, nothing written\n`);
      return 0;
    }
  }

  if (!baseUrl) baseUrl = DEFAULT_CONFIG.baseUrl;
  if (!model) model = DEFAULT_CONFIG.model;
  baseUrl = normalizeBaseUrl(baseUrl);

  if (!apiKey && !isLoopbackUrl(baseUrl)) {
    throw new UsageError('an API key is required for a remote endpoint', {
      hint: 'pass --api-key sk-..., or set SHITC_API_KEY / OPENAI_API_KEY',
    });
  }

  const saved = saveConfig({
    baseUrl,
    apiKey,
    model,
    temperature,
    maxTokens,
    timeoutMs: existingConfig?.timeoutMs ?? DEFAULT_CONFIG.timeoutMs,
    reasoningParam,
    reasoningValue,
  });

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          path: saved.path,
          dir: configDir(),
          config: { ...saved.config, apiKey: maskSecret(saved.config.apiKey) },
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  process.stderr.write(`${color.green(symbol.ok)} wrote ${saved.path} ${color.dim('(mode 0600)')}\n`);
  process.stderr.write(`  ${color.dim('list models')}  ${PROGRAM} models\n`);
  process.stderr.write(`  ${color.dim('try')}          ${PROGRAM} examples/hello.shit\n`);
  return 0;
}

function parseReasoningFlag(raw: string): { param: string; value: string } {
  const text = raw.trim();
  if (!text || /^(none|off|no|false)$/i.test(text)) return { param: '', value: '' };

  const equals = text.indexOf('=');
  if (equals <= 0) {
    throw new UsageError('--reasoning expects <param>=<value>', {
      hint: 'e.g. --reasoning reasoning_effort=high (or --reasoning none to disable)',
    });
  }

  const param = text.slice(0, equals).trim();
  const value = text.slice(equals + 1).trim();
  if (!param || !value) {
    throw new UsageError('--reasoning needs both a parameter and a value', {
      hint: 'e.g. --reasoning reasoning_effort=high',
    });
  }
  return { param, value };
}

function guessPresetIndex(baseUrl: string | undefined): number {
  if (!baseUrl) return 0;
  const normalized = normalizeBaseUrl(baseUrl);
  const index = PRESETS.findIndex((preset) => preset.baseUrl && normalizeBaseUrl(preset.baseUrl) === normalized);
  return index >= 0 ? index : PRESETS.length - 1;
}
