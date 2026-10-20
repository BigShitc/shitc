import assert from 'node:assert/strict';
import { chmodSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  DEFAULT_CONFIG,
  assertConfigured,
  outputRoot,
  configDir,
  configPath,
  describeConfig,
  inspectConfig,
  loadConfig,
  normalizeBaseUrl,
  parseConfigAssignment,
  saveConfig,
  type ShitcConfig,
} from '../src/config.js';
import { InternalCompilerError } from '../src/errors.js';
import { makeTempDir, removeDir } from './helpers.js';

const ENV_KEYS = [
  'SHITC_CONFIG_DIR',
  'SHITC_ARTIFACT_DIR',
  'SHITC_OUT_DIR',
  'SHITC_BASE_URL',
  'SHITC_API_KEY',
  'SHITC_MODEL',
  'SHITC_TEMPERATURE',
  'SHITC_MAX_TOKENS',
  'SHITC_TIMEOUT_MS',
  'SHITC_REASONING',
  'SHITC_REASONING_PARAM',
  'SHITC_REASONING_VALUE',
  'OPENAI_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_MODEL',
];

let dir = '';
const savedEnv = new Map<string, string | undefined>();

before(() => {
  for (const key of ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  dir = makeTempDir('shitc-config-');
  process.env.SHITC_CONFIG_DIR = dir;
});

after(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  removeDir(dir);
});

beforeEach(() => {
  process.env.SHITC_CONFIG_DIR = dir;
  for (const key of ENV_KEYS) {
    if (key === 'SHITC_CONFIG_DIR') continue;
    delete process.env[key];
  }
  removeDir(configPath());
});

describe('config paths', () => {
  it('defaults to ~/.shitc and honors SHITC_CONFIG_DIR', () => {
    assert.equal(configDir(), dir);
    assert.equal(configPath(), path.join(dir, 'config.json'));

    process.env.SHITC_CONFIG_DIR = '~/custom-shitc';
    assert.ok(configDir().endsWith(`${path.sep}custom-shitc`));
    process.env.SHITC_CONFIG_DIR = dir;
  });

  it('defaults the output root to ~/.shitc/build and honors SHITC_OUT_DIR', () => {
    assert.equal(outputRoot(), path.join(dir, 'build'));
    process.env.SHITC_OUT_DIR = path.join(dir, 'out');
    assert.equal(outputRoot(), path.join(dir, 'out'));
    delete process.env.SHITC_OUT_DIR;

    process.env.SHITC_ARTIFACT_DIR = path.join(dir, 'legacy');
    assert.equal(outputRoot(), path.join(dir, 'legacy'));
    delete process.env.SHITC_ARTIFACT_DIR;
  });
});

describe('config loading', () => {
  it('falls back to defaults with no config file', () => {
    const loaded = loadConfig();
    assert.equal(loaded.exists, false);
    assert.deepEqual(loaded.config, DEFAULT_CONFIG);
    assert.equal(loaded.sources.model, 'default');
    assert.deepEqual(loaded.warnings, []);
  });

  it('reads aliases from the config file', () => {
    writeFileSync(
      configPath(),
      JSON.stringify({ base_url: 'https://example.test/v1', 'api-key': 'sk-file', model: 'file-model', timeout: 5000 }),
    );
    const loaded = loadConfig();
    assert.equal(loaded.exists, true);
    assert.equal(loaded.config.baseUrl, 'https://example.test/v1');
    assert.equal(loaded.config.apiKey, 'sk-file');
    assert.equal(loaded.config.model, 'file-model');
    assert.equal(loaded.config.timeoutMs, 5000);
    assert.equal(loaded.sources.model, 'file');
  });

  it('lets environment variables override the file', () => {
    writeFileSync(configPath(), JSON.stringify({ model: 'file-model', baseUrl: 'https://file.test/v1' }));
    process.env.SHITC_MODEL = 'env-model';
    process.env.OPENAI_API_KEY = 'sk-env';
    process.env.SHITC_MAX_TOKENS = '2048';

    const loaded = loadConfig();
    assert.equal(loaded.config.model, 'env-model');
    assert.equal(loaded.config.apiKey, 'sk-env');
    assert.equal(loaded.config.maxTokens, 2048);
    assert.equal(loaded.config.baseUrl, 'https://file.test/v1');
    assert.equal(loaded.sources.model, 'env');
  });

  it('reports a clear ICE-001 for broken JSON', () => {
    writeFileSync(configPath(), '{ not json');
    try {
      loadConfig();
      assert.fail('expected ICE-001');
    } catch (err) {
      assert.ok(err instanceof InternalCompilerError);
      assert.equal(err.code, 'ICE-001');
      assert.match(err.message, /not valid JSON/);
    }
  });

  it('reports ICE-001 for a non-object config', () => {
    writeFileSync(configPath(), '["nope"]');
    assert.throws(
      () => loadConfig(),
      (err: unknown) => err instanceof InternalCompilerError && err.code === 'ICE-001',
    );
  });

  it('ignores non-numeric numbers with a warning', () => {
    writeFileSync(configPath(), JSON.stringify({ maxTokens: 'many' }));
    const loaded = loadConfig();
    assert.equal(loaded.config.maxTokens, DEFAULT_CONFIG.maxTokens);
    assert.equal(loaded.warnings.length, 1);
  });

  it('reads reasoning / CoT aliases from the config file', () => {
    writeFileSync(configPath(), JSON.stringify({ cot: 'reasoning_effort', 'reasoning-level': 'high' }));
    const loaded = loadConfig();
    assert.equal(loaded.config.reasoningParam, 'reasoning_effort');
    assert.equal(loaded.config.reasoningValue, 'high');
    assert.equal(loaded.sources.reasoningParam, 'file');
    assert.equal(loaded.sources.reasoningValue, 'file');
  });

  it('parses SHITC_REASONING=param=value', () => {
    process.env.SHITC_REASONING = 'reasoning_effort=medium';
    const loaded = loadConfig();
    assert.equal(loaded.config.reasoningParam, 'reasoning_effort');
    assert.equal(loaded.config.reasoningValue, 'medium');
    assert.equal(loaded.sources.reasoningParam, 'env');
  });

  it('supports separate reasoning env vars', () => {
    process.env.SHITC_REASONING_PARAM = 'enable_thinking';
    process.env.SHITC_REASONING_VALUE = 'true';
    const loaded = loadConfig();
    assert.equal(loaded.config.reasoningParam, 'enable_thinking');
    assert.equal(loaded.config.reasoningValue, 'true');
  });
});

describe('config validation', () => {
  const base: ShitcConfig = { ...DEFAULT_CONFIG, apiKey: 'sk-test' };

  it('accepts a complete config', () => {
    assert.deepEqual(inspectConfig(base), []);
    assert.doesNotThrow(() => assertConfigured(base));
  });

  it('requires an api key for remote endpoints', () => {
    const issues = inspectConfig({ ...base, apiKey: '' });
    assert.equal(issues.length, 1);
    assert.equal(issues[0]?.field, 'apiKeyMissing');
    assert.throws(
      () => assertConfigured({ ...base, apiKey: '' }),
      (err: unknown) => err instanceof InternalCompilerError && err.code === 'ICE-001',
    );
  });

  it('does not require an api key for loopback endpoints', () => {
    assert.deepEqual(inspectConfig({ ...base, apiKey: '', baseUrl: 'http://127.0.0.1:11434/v1' }), []);
    assert.deepEqual(inspectConfig({ ...base, apiKey: '', baseUrl: 'http://localhost:8080/v1' }), []);
    assert.doesNotThrow(() => assertConfigured({ ...base, apiKey: '', baseUrl: 'http://127.0.0.1:1234/v1' }));
  });

  it('rejects invalid numbers and urls', () => {
    const issues = inspectConfig({ ...base, temperature: 5, maxTokens: 1, timeoutMs: 10, baseUrl: 'ftp://x' });
    const fields = issues.map((issue) => issue.field);
    assert.ok(fields.includes('temperature'));
    assert.ok(fields.includes('maxTokens'));
    assert.ok(fields.includes('timeoutMs'));
    assert.ok(fields.includes('baseUrl'));
  });

  it('validates the reasoning / CoT parameter', () => {
    assert.deepEqual(inspectConfig({ ...base, reasoningParam: '', reasoningValue: '' }), []);
    assert.deepEqual(inspectConfig({ ...base, reasoningParam: 'reasoning_effort', reasoningValue: 'high' }), []);

    assert.deepEqual(inspectConfig({ ...base, reasoningParam: 'enable_thinking', reasoningValue: '' }), []);

    const missingParam = inspectConfig({ ...base, reasoningParam: '', reasoningValue: 'high' });
    assert.equal(missingParam[0]?.field, 'reasoningParam');

    const reserved = inspectConfig({ ...base, reasoningParam: 'temperature', reasoningValue: '1' });
    assert.equal(reserved[0]?.field, 'reasoningParam');

    const invalidName = inspectConfig({ ...base, reasoningParam: 'bad name!', reasoningValue: 'x' });
    assert.equal(invalidName[0]?.field, 'reasoningParam');
  });
});

describe('config saving', () => {
  it('writes 0600 and merges with existing keys', () => {
    writeFileSync(configPath(), JSON.stringify({ custom: 'keep-me' }));
    const saved = saveConfig({ model: 'saved-model', apiKey: 'sk-saved' });

    assert.equal(saved.path, configPath());
    assert.equal(saved.config.model, 'saved-model');

    const raw = JSON.parse(readFileSync(configPath(), 'utf8')) as Record<string, unknown>;
    assert.equal(raw.custom, 'keep-me');
    assert.equal(raw.model, 'saved-model');

    if (process.platform !== 'win32') {
      const mode = statSync(configPath()).mode & 0o777;
      assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
    }
  });

  it('rejects invalid values without writing', () => {
    saveConfig({ model: 'stable-model' });
    const before = readFileSync(configPath(), 'utf8');
    assert.throws(
      () => saveConfig({ baseUrl: 'not a url' }),
      (err: unknown) => err instanceof InternalCompilerError && err.code === 'ICE-001',
    );
    assert.equal(readFileSync(configPath(), 'utf8'), before);
  });

  it('describeConfig masks the api key', () => {
    saveConfig({ apiKey: 'sk-abcdefghijklmnop' });
    const rows = describeConfig(loadConfig());
    const apiKey = rows.find((row) => row.key === 'apiKey');
    assert.ok(apiKey);
    assert.doesNotMatch(apiKey.value, /abcdefghijklmnop/);
  });

  it('persists the reasoning parameter and shows it in describeConfig', () => {
    saveConfig({ reasoningParam: 'reasoning_effort', reasoningValue: 'max' });

    const raw = JSON.parse(readFileSync(configPath(), 'utf8')) as Record<string, unknown>;
    assert.equal(raw.reasoningParam, 'reasoning_effort');
    assert.equal(raw.reasoningValue, 'max');

    const rows = describeConfig(loadConfig());
    assert.equal(rows.find((row) => row.key === 'reasoningParam')?.value, 'reasoning_effort = max');
  });
});

describe('config helpers', () => {
  it('normalizes base urls', () => {
    assert.equal(normalizeBaseUrl('https://api.openai.com'), 'https://api.openai.com/v1');
    assert.equal(normalizeBaseUrl('https://api.openai.com/'), 'https://api.openai.com/v1');
    assert.equal(normalizeBaseUrl('https://api.deepseek.com/v1/'), 'https://api.deepseek.com/v1');
    assert.equal(normalizeBaseUrl('http://127.0.0.1:11434/v1'), 'http://127.0.0.1:11434/v1');
    assert.equal(normalizeBaseUrl('  '), DEFAULT_CONFIG.baseUrl);
  });

  it('parses config assignments', () => {
    assert.deepEqual(parseConfigAssignment('timeout', '5000'), { key: 'timeoutMs', value: 5000 });
    assert.deepEqual(parseConfigAssignment('model', ' gpt-4o '), { key: 'model', value: 'gpt-4o' });
    assert.throws(
      () => parseConfigAssignment('nope', 'x'),
      (err: unknown) => err instanceof InternalCompilerError && err.code === 'ICE-001',
    );
    assert.throws(
      () => parseConfigAssignment('maxTokens', 'lots'),
      (err: unknown) => err instanceof InternalCompilerError && err.code === 'ICE-001',
    );
  });

  it('chmods to 0600 even if the file was permissive', (t) => {
    if (process.platform === 'win32') return t.skip('POSIX permissions');
    writeFileSync(configPath(), '{}');
    chmodSync(configPath(), 0o666);
    saveConfig({ model: 'x' });
    assert.equal(statSync(configPath()).mode & 0o777, 0o600);
  });
});
