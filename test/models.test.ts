import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fetchModels, formatModelList, resolveModelSelection, runModelsCommand } from '../src/models.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { makeTempDir, removeDir, runCli, startMockServer } from './helpers.js';

let tempRoot = '';
let caseCounter = 0;

before(() => {
  tempRoot = makeTempDir('shitc-models-');
});

after(() => {
  removeDir(tempRoot);
});

const MODELS = ['gpt-4o-mini', 'gpt-4o', 'deepseek-chat', 'deepseek-reasoner', 'qwen-plus', 'qwen-turbo', 'llama-3.3-70b'];
const SORTED_MODELS = [...MODELS].sort((a, b) => a.localeCompare(b));

function modelsReply(ids: string[] = MODELS) {
  return { body: { object: 'list', data: ids.map((id) => ({ id, object: 'model' })) } };
}

function envFor(mock: { url: string }): { env: Record<string, string>; configDir: string; id: number } {
  const id = (caseCounter += 1);
  const configDir = path.join(tempRoot, 'config', `case-${id}`);
  mkdirSync(configDir, { recursive: true });
  return {
    id,
    configDir,
    env: {
      SHITC_CONFIG_DIR: configDir,
      SHITC_BASE_URL: `${mock.url}/v1`,
      SHITC_API_KEY: 'test-key',
      SHITC_MODEL: 'gpt-4o-mini',
      SHITC_OUT_DIR: path.join(tempRoot, 'out'),
    },
  };
}

describe('resolveModelSelection', () => {
  it('selects by 1-based number, with or without #', () => {
    assert.equal(resolveModelSelection('#6', SORTED_MODELS), 'qwen-plus');
    assert.equal(resolveModelSelection('6', SORTED_MODELS), 'qwen-plus');
    assert.equal(resolveModelSelection('#1', SORTED_MODELS), 'deepseek-chat');
  });

  it('selects by exact name and unique prefix', () => {
    assert.equal(resolveModelSelection('deepseek-reasoner', MODELS), 'deepseek-reasoner');
    assert.equal(resolveModelSelection('QWEN-PLUS', MODELS), 'qwen-plus');
    assert.equal(resolveModelSelection('llama', MODELS), 'llama-3.3-70b');
  });

  it('returns null for out-of-range, ambiguous or unknown selections', () => {
    assert.equal(resolveModelSelection('#0', MODELS), null);
    assert.equal(resolveModelSelection('#99', MODELS), null);
    assert.equal(resolveModelSelection('qwen', MODELS), null, 'two qwen models -> ambiguous');
    assert.equal(resolveModelSelection('nope', MODELS), null);
    assert.equal(resolveModelSelection('   ', MODELS), null);
  });

  it('formats a numbered list and marks the current model', () => {
    const lines = formatModelList(MODELS, 'deepseek-chat').join('\n');
    assert.match(lines, /1\s+gpt-4o-mini/);
    assert.match(lines, /3\s+deepseek-chat \*/);
  });
});

describe('fetchModels', () => {
  it('parses data[].id, sorts and dedupes', async () => {
    const mock = await startMockServer(() => ({ body: { data: [{ id: 'b' }, { id: 'a' }, { id: 'a' }] } }));
    try {
      const config = { ...DEFAULT_CONFIG, baseUrl: `${mock.url}/v1`, apiKey: 'k' };
      assert.deepEqual(await fetchModels(config), ['a', 'b']);
    } finally {
      await mock.close();
    }
  });

  it('accepts a bare array and a models[] wrapper', async () => {
    for (const body of [['x', 'y'], { models: [{ id: 'x' }, { id: 'y' }] }]) {
      const mock = await startMockServer(() => ({ body }));
      try {
        const config = { ...DEFAULT_CONFIG, baseUrl: `${mock.url}/v1`, apiKey: 'k' };
        assert.deepEqual(await fetchModels(config), ['x', 'y']);
      } finally {
        await mock.close();
      }
    }
  });

  it('reports auth errors as ICE-002', async () => {
    const mock = await startMockServer(() => ({ status: 401, body: { error: { message: 'bad key' } } }));
    try {
      const config = { ...DEFAULT_CONFIG, baseUrl: `${mock.url}/v1`, apiKey: 'k' };
      await assert.rejects(fetchModels(config), (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /HTTP 401/);
        return true;
      });
    } finally {
      await mock.close();
    }
  });
});

describe('shitc models CLI', () => {
  it('lists models as JSON', async () => {
    const mock = await startMockServer(() => modelsReply());
    try {
      const { env } = envFor(mock);
      const result = await runCli(['models', '--json'], { env });
      assert.equal(result.code, 0, `stderr:\n${result.stderr}`);
      const payload = JSON.parse(result.stdout) as { ok: boolean; count: number; models: string[]; current: string };
      assert.equal(payload.ok, true);
      assert.equal(payload.count, MODELS.length);
      assert.deepEqual(payload.models, [...MODELS].sort());
      assert.equal(payload.current, 'gpt-4o-mini');
    } finally {
      await mock.close();
    }
  });

  it('selects the sixth model with "#6" and saves it', async () => {
    const mock = await startMockServer(() => modelsReply());
    try {
      const { env, configDir } = envFor(mock);
      const result = await runCli(['models', '#6'], { env });
      assert.equal(result.code, 0, `stderr:\n${result.stderr}`);
      assert.match(result.stdout, /model = qwen-plus/);

      const saved = JSON.parse(readFileSync(path.join(configDir, 'config.json'), 'utf8')) as { model: string };
      assert.equal(saved.model, 'qwen-plus');

      const { SHITC_MODEL: _ignored, ...noModelEnv } = env;
      const get = await runCli(['config', 'get', 'model'], { env: noModelEnv });
      assert.equal(get.stdout.trim(), 'qwen-plus');
    } finally {
      await mock.close();
    }
  });

  it('prints a numbered list without a TTY and hints at "#n"', async () => {
    const mock = await startMockServer(() => modelsReply());
    try {
      const { env } = envFor(mock);
      const result = await runCli(['models'], { env });
      assert.equal(result.code, 0, `stderr:\n${result.stderr}`);
      assert.match(result.stdout, /1\s+deepseek-chat/);
      assert.match(result.stdout, /6\s+qwen-plus/);
      assert.match(result.stdout, /'#6'/);
    } finally {
      await mock.close();
    }
  });

  it('rejects an out-of-range selector with exit 64', async () => {
    const mock = await startMockServer(() => modelsReply());
    try {
      const { env } = envFor(mock);
      const result = await runCli(['models', '#99'], { env });
      assert.equal(result.code, 64);
      assert.match(result.stderr, /not one of the 7 models/);
    } finally {
      await mock.close();
    }
  });

  it('saves the selection through runModelsCommand directly', async () => {
    const mock = await startMockServer(() => modelsReply());
    try {
      const { env } = envFor(mock);
      const saved = process.env.SHITC_CONFIG_DIR;
      const savedBase = process.env.SHITC_BASE_URL;
      const savedKey = process.env.SHITC_API_KEY;
      Object.assign(process.env, env);
      try {
        assert.equal(await runModelsCommand({ selector: '2', json: false }), 0);
        const config = JSON.parse(readFileSync(path.join(env.SHITC_CONFIG_DIR!, 'config.json'), 'utf8')) as { model: string };
        assert.equal(config.model, 'deepseek-reasoner');
      } finally {
        for (const [key, value] of [
          ['SHITC_CONFIG_DIR', saved],
          ['SHITC_BASE_URL', savedBase],
          ['SHITC_API_KEY', savedKey],
        ] as const) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    } finally {
      await mock.close();
    }
  });
});
