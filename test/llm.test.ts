import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type { ShitcConfig } from '../src/config.js';
import { InternalCompilerError } from '../src/errors.js';
import { chat, coerceReasoningValue, type ChatMessage } from '../src/llm.js';
import { jsonReply, makeTempDir, removeDir, sseReply, startMockServer, type MockServer } from './helpers.js';

const messages: ChatMessage[] = [
  { role: 'system', content: 'you are a compiler' },
  { role: 'user', content: 'prit("hi")' },
];

const tempDirs: string[] = [];
const servers: MockServer[] = [];

function configFor(url: string, overrides: Partial<ShitcConfig> = {}): ShitcConfig {
  return {
    baseUrl: `${url}/v1`,
    apiKey: 'test-key',
    model: 'mock-model',
    temperature: 0,
    maxTokens: 256,
    timeoutMs: 5000,
    reasoningParam: '',
    reasoningValue: '',
    ...overrides,
  };
}

async function server(handler: Parameters<typeof startMockServer>[0]): Promise<MockServer> {
  const instance = await startMockServer(handler);
  servers.push(instance);
  return instance;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((instance) => instance.close()));
  for (const dir of tempDirs.splice(0)) removeDir(dir);
});

async function expectIce(promise: Promise<unknown>, code: string, pattern?: RegExp): Promise<InternalCompilerError> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof InternalCompilerError, `expected ICE, got ${String(err)}`);
    assert.equal(err.code, code);
    if (pattern) assert.match(err.message, pattern);
    return err;
  }
  throw new assert.AssertionError({ message: 'expected the request to fail' });
}

describe('OpenAI protocol client', () => {
  it('streams SSE deltas and assembles the completion', async () => {
    const mock = await server(() => sseReply('{"language":"python"}'));
    const deltas: string[] = [];

    const result = await chat(configFor(mock.url), messages, {
      onDelta: (delta) => deltas.push(delta),
    });

    assert.equal(result.content, '{"language":"python"}');
    assert.equal(result.streamed, true);
    assert.equal(result.finishReason, 'stop');
    assert.equal(result.usage?.totalTokens, 30);
    assert.ok(deltas.length > 1, 'expected multiple deltas');
    assert.equal(deltas.join(''), result.content);
  });

  it('accepts a non-SSE JSON body even when streaming was requested', async () => {
    const mock = await server(() => jsonReply('{"language":"c"}'));
    const result = await chat(configFor(mock.url), messages, {});
    assert.equal(result.content, '{"language":"c"}');
    assert.equal(result.streamed, false);
    assert.equal(result.usage?.completionTokens, 6);
  });

  it('sends an OpenAI-compatible request with schema + stream options', async () => {
    const mock = await server(() => jsonReply('ok'));
    await chat(configFor(mock.url), messages, {});

    const request = mock.requests[0]!;
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(request.headers.authorization, 'Bearer test-key');
    assert.equal(request.body.model, 'mock-model');
    assert.equal(request.body.stream, true);
    assert.equal(request.body.max_tokens, 256);
    assert.deepEqual(request.body.stream_options, { include_usage: true });
    assert.equal((request.body.response_format as Record<string, unknown>).type, 'json_schema');
    assert.equal((request.body.messages as unknown[]).length, 2);
  });

  it('sends the configured reasoning / CoT parameter', async () => {
    const mock = await server(() => jsonReply('ok'));
    await chat(configFor(mock.url, { reasoningParam: 'reasoning_effort', reasoningValue: 'high' }), messages, {});
    assert.equal(mock.requests[0]!.body.reasoning_effort, 'high');
  });

  it('coerces boolean and numeric reasoning values', async () => {
    const mock = await server(() => jsonReply('ok'));
    await chat(configFor(mock.url, { reasoningParam: 'enable_thinking', reasoningValue: 'true' }), messages, {});
    assert.equal(mock.requests[0]!.body.enable_thinking, true);

    assert.equal(coerceReasoningValue('max'), 'max');
    assert.equal(coerceReasoningValue('true'), true);
    assert.equal(coerceReasoningValue('false'), false);
    assert.equal(coerceReasoningValue('0.7'), 0.7);
    assert.deepEqual(coerceReasoningValue('{"type":"enabled"}'), { type: 'enabled' });
    assert.equal(coerceReasoningValue(''), true);
  });

  it('drops the reasoning parameter when the provider rejects it', async () => {
    let calls = 0;
    const mock = await server(() => {
      calls += 1;
      if (calls === 1) return { status: 400, body: { error: { message: 'Unsupported parameter: reasoning_effort' } } };
      return jsonReply('ok');
    });

    const result = await chat(
      configFor(mock.url, { reasoningParam: 'reasoning_effort', reasoningValue: 'high' }),
      messages,
      {},
    );

    assert.equal(result.content, 'ok');
    assert.equal(mock.requests.length, 2);
    assert.equal(mock.requests[0]!.body.reasoning_effort, 'high');
    assert.equal(mock.requests[1]!.body.reasoning_effort, undefined);
    assert.ok(result.degraded.some((entry) => entry.includes('reasoning_effort=off')));
  });

  it('retries transient 5xx responses', async () => {
    let calls = 0;
    const mock = await server(() => {
      calls += 1;
      if (calls === 1) return { status: 503, body: { error: { message: 'overloaded' } } };
      return jsonReply('recovered');
    });

    const result = await chat(configFor(mock.url), messages, {});
    assert.equal(result.content, 'recovered');
    assert.equal(mock.requests.length, 2);
    assert.equal(result.attempts, 2);
  });

  it('degrades json_schema to json_object when the provider rejects it', async () => {
    let calls = 0;
    const mock = await server(() => {
      calls += 1;
      if (calls === 1) {
        return { status: 400, body: { error: { message: 'Invalid parameter: response_format is not supported by this model' } } };
      }
      return jsonReply('{"language":"python"}');
    });

    const result = await chat(configFor(mock.url), messages, {});
    assert.equal(result.content, '{"language":"python"}');
    assert.equal(mock.requests.length, 2);
    assert.equal((mock.requests[1]!.body.response_format as Record<string, unknown>).type, 'json_object');
    assert.equal(result.degraded.length, 1);
  });

  it('switches to max_completion_tokens when max_tokens is rejected', async () => {
    let calls = 0;
    const mock = await server(() => {
      calls += 1;
      if (calls === 1) return { status: 400, body: { error: { message: 'Unsupported parameter: max_tokens' } } };
      return jsonReply('ok');
    });

    await chat(configFor(mock.url), messages, {});
    assert.equal(mock.requests.length, 2);
    assert.equal(mock.requests[1]!.body.max_completion_tokens, 256);
    assert.equal(mock.requests[1]!.body.max_tokens, undefined);
  });

  it('reports auth failures as ICE-002', async () => {
    const mock = await server(() => ({ status: 401, body: { error: { message: 'invalid api key' } } }));
    const err = await expectIce(chat(configFor(mock.url), messages, {}), 'ICE-002', /API key/);
    assert.match(err.hint ?? '', /shitc init/);
  });

  it('reports timeouts as ICE-002', async () => {
    const mock = await server(() => ({ ...jsonReply('late'), delayMs: 1500 }));
    const err = await expectIce(chat(configFor(mock.url, { timeoutMs: 250 }), messages, {}), 'ICE-002', /timed out/);
    assert.ok(err.hint?.includes('timeoutMs'));
  });

  it('reports unreachable endpoints as ICE-002', async () => {
    const mock = await server(() => jsonReply('x'));
    const baseUrl = `${mock.url}/v1`;
    await mock.close();
    servers.splice(servers.indexOf(mock), 1);

    await expectIce(chat({ ...configFor(mock.url), baseUrl }, messages, {}), 'ICE-002', /cannot reach/);
  });

  it('rejects non-JSON bodies with ICE-003', async () => {
    const mock = await server(() => ({ status: 200, contentType: 'text/html', body: '<html>gateway</html>' }));
    await expectIce(chat(configFor(mock.url), messages, {}), 'ICE-003', /non-JSON/);
  });

  it('reports empty completions as ICE-003 after degrading the schema', async () => {
    const mock = await server(() => jsonReply(''));
    const err = await expectIce(chat(configFor(mock.url), messages, {}), 'ICE-003', /empty completion/);
    assert.match(err.hint ?? '', /maxTokens/);
    assert.equal(mock.requests.length, 3, 'json_schema -> json_object -> off');
  });
});
