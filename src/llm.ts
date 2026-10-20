import type { ShitcConfig } from './config.js';
import { ICE, InternalCompilerError, InterruptedError } from './errors.js';
import { PLAN_SCHEMA } from './schema.js';
import { isPlainObject, oneLine, sleep, truncate } from './util.js';
import { USER_AGENT } from './version.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatOptions {

  stream?: boolean;

  useResponseFormat?: boolean;
  onDelta?: (delta: string, totalChars: number) => void;
  signal?: AbortSignal;
  temperature?: number;
  maxTokens?: number;

  debug?: (message: string, detail?: string) => void;
}

export interface ChatResult {
  content: string;
  usage: Usage | null;
  finishReason: string | null;
  streamed: boolean;
  attempts: number;
  degraded: string[];
  durationMs: number;
  model: string;
}

type SchemaMode = 'json_schema' | 'json_object' | 'off';
type TokenField = 'max_tokens' | 'max_completion_tokens';

interface Strategy {
  schema: SchemaMode;
  stream: boolean;
  streamOptions: boolean;
  tokenField: TokenField;

  reasoning: boolean;

  reasoningParam: string;
}

interface RawCompletion {
  content: string;
  usage: Usage | null;
  finishReason: string | null;
  streamed: boolean;
}

const MAX_ATTEMPTS = 6;
const MAX_BACKOFF_MS = 8000;

class HttpError extends Error {
  readonly status: number;
  readonly body: string;
  readonly retryAfterMs: number | null;

  constructor(status: number, body: string, retryAfterMs: number | null) {
    super(`HTTP ${status}`);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
    this.retryAfterMs = retryAfterMs;
  }
}

class EmptyCompletion extends Error {
  readonly finishReason: string | null;
  constructor(finishReason: string | null) {
    super('empty completion');
    this.name = 'EmptyCompletion';
    this.finishReason = finishReason;
  }
}

export async function chat(config: ShitcConfig, messages: ChatMessage[], options: ChatOptions = {}): Promise<ChatResult> {
  const startedAt = Date.now();
  const requestModel = config.model;
  const streamRequested = options.stream !== false;

  const strategy: Strategy = {
    schema: options.useResponseFormat === false ? 'off' : 'json_schema',
    stream: streamRequested,
    streamOptions: streamRequested,
    tokenField: 'max_tokens',
    reasoning: Boolean(config.reasoningParam.trim()),
    reasoningParam: config.reasoningParam.trim(),
  };

  const degraded: string[] = [];
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, config.timeoutMs);
    timer.unref?.();
    const onExternalAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onExternalAbort, { once: true });

    try {
      const url = `${config.baseUrl}/chat/completions`;
      const body = buildRequestBody(requestModel, messages, strategy, options, config);
      options.debug?.(
        'request',
        `${url} · model=${requestModel} · stream=${strategy.stream} · schema=${strategy.schema} · tokenField=${strategy.tokenField}`,
      );

      const response = await fetch(url, {
        method: 'POST',
        headers: buildHeaders(config, strategy.stream),
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new HttpError(response.status, text, parseRetryAfter(response.headers.get('retry-after')));
      }

      const raw = await consumeResponse(response, options, strategy);
      options.debug?.(
        'response',
        `stream=${raw.streamed} finish=${raw.finishReason ?? 'n/a'} usage=${raw.usage ? `${raw.usage.promptTokens}+${raw.usage.completionTokens}` : 'n/a'} chars=${raw.content.length}`,
      );

      if (!raw.content.trim()) throw new EmptyCompletion(raw.finishReason);

      return {
        content: raw.content,
        usage: raw.usage,
        finishReason: raw.finishReason,
        streamed: raw.streamed,
        attempts: attempt,
        degraded,
        durationMs: Date.now() - startedAt,
        model: requestModel,
      };
    } catch (err) {
      const decision = decide(err, {
        config,
        strategy,
        attempt,
        timedOut,
        externallyAborted: options.signal?.aborted === true,
        degraded,
        streamRequested,
      });

      if (decision === 'retry' || decision === 'degrade' || decision === 'degrade-and-retry') {
        lastError = err;
        if (decision === 'retry') {
          const delay = backoffFor(attempt, err);
          options.debug?.('retry', `attempt ${attempt} failed (${describe(err)}), retrying in ${delay}ms`);
          await sleep(delay);
        } else {
          options.debug?.('degrade', `attempt ${attempt} failed (${describe(err)}), retrying with: ${describeStrategy(strategy)}`);
        }
        continue;
      }

      throw decision;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  throw new InternalCompilerError(ICE.REQUEST, `model request failed after ${MAX_ATTEMPTS} attempts`, {
    hint: 'the endpoint or model may be misconfigured; run "shitc doctor"',
    detail: lastError ? describe(lastError) : undefined,
  });
}

function buildHeaders(config: ShitcConfig, stream: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: stream ? 'text/event-stream' : 'application/json',
    'user-agent': USER_AGENT,
  };
  if (config.apiKey.trim()) headers.authorization = `Bearer ${config.apiKey.trim()}`;
  return headers;
}

function buildRequestBody(
  model: string,
  messages: ChatMessage[],
  strategy: Strategy,
  options: ChatOptions,
  config: ShitcConfig,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages: messages.map((message) => ({ role: message.role, content: message.content })),
    temperature: options.temperature ?? config.temperature,
    [strategy.tokenField]: options.maxTokens ?? config.maxTokens,
    stream: strategy.stream,
  };

  if (strategy.stream && strategy.streamOptions) {
    body.stream_options = { include_usage: true };
  }

  if (strategy.schema === 'json_schema') {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: 'shitlang_ir', strict: true, schema: PLAN_SCHEMA },
    };
  } else if (strategy.schema === 'json_object') {
    body.response_format = { type: 'json_object' };
  }

  if (strategy.reasoning && strategy.reasoningParam) {
    body[strategy.reasoningParam] = coerceReasoningValue(config.reasoningValue);
  }

  return body;
}

export function coerceReasoningValue(raw: string): unknown {
  const value = raw.trim();
  if (!value) return true;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(value)) return Number(value);
  if (/^[[{]/.test(value)) {
    try {
      return JSON.parse(value);
    } catch {

    }
  }
  return value;
}

type Decision = 'retry' | 'degrade' | 'degrade-and-retry' | InternalCompilerError | InterruptedError;

interface DecideContext {
  config: ShitcConfig;
  strategy: Strategy;
  attempt: number;
  timedOut: boolean;
  externallyAborted: boolean;
  degraded: string[];
  streamRequested: boolean;
}

function decide(err: unknown, ctx: DecideContext): Decision {
  const { config, strategy, attempt, degraded } = ctx;

  if (err instanceof InterruptedError) return err;
  if (ctx.externallyAborted) return new InterruptedError('compile cancelled');
  if (err instanceof InternalCompilerError) return err;

  if (ctx.timedOut) {
    return new InternalCompilerError(ICE.REQUEST, `model request timed out after ${config.timeoutMs}ms`, {
      hint: 'raise timeoutMs ("shitc config set timeoutMs 300000") or use a faster model',
      cause: err,
    });
  }

  if (err instanceof HttpError) {
    const message = extractErrorMessage(err.body);
    const hintText = `${message}`.toLowerCase();

    if (err.status === 401 || err.status === 403) {
      return new InternalCompilerError(ICE.REQUEST, `model endpoint rejected the API key (HTTP ${err.status})`, {
        hint: 'check "shitc config get apiKey" or re-run "shitc init"',
        detail: oneLine(message, 300),
        cause: err,
      });
    }

    if (err.status === 404) {
      return new InternalCompilerError(ICE.REQUEST, `model endpoint not found (HTTP 404): ${config.baseUrl}/chat/completions`, {
        hint: 'baseUrl usually ends with /v1 (e.g. https://api.openai.com/v1)',
        detail: oneLine(message, 300),
        cause: err,
      });
    }

    if (isRetryableStatus(err.status) && attempt < 3) return 'retry';

    if (degrade(strategy, err.status, hintText)) {
      degraded.push(describeStrategy(strategy));
      return 'degrade-and-retry';
    }

    return new InternalCompilerError(ICE.REQUEST, `model request failed (HTTP ${err.status})`, {
      hint: 'run "shitc doctor" to check the endpoint and model name',
      detail: oneLine(message, 500),
      cause: err,
    });
  }

  if (err instanceof EmptyCompletion) {
    if (strategy.schema === 'json_schema') {
      strategy.schema = 'json_object';
      degraded.push(describeStrategy(strategy));
      return 'degrade-and-retry';
    }
    if (strategy.schema === 'json_object') {
      strategy.schema = 'off';
      degraded.push(describeStrategy(strategy));
      return 'degrade-and-retry';
    }
    return new InternalCompilerError(ICE.RESPONSE, 'model returned an empty completion', {
      hint:
        err.finishReason === 'length'
          ? 'the model hit the token limit before answering; raise maxTokens'
          : 'try a different model, or raise maxTokens',
      detail: `finish_reason: ${err.finishReason ?? 'unknown'}`,
      cause: err,
    });
  }

  if (isNetworkError(err)) {
    if (attempt < 3) return 'retry';
    return new InternalCompilerError(ICE.REQUEST, `cannot reach the model endpoint (${new URL(config.baseUrl).host})`, {
      hint: 'check network/proxy, or set baseUrl for a local server (e.g. http://127.0.0.1:11434/v1)',
      detail: describe(err),
      cause: err,
    });
  }

  if (err instanceof SyntaxError || (err instanceof Error && err.name === 'AbortError')) {
    if (attempt < 3) return 'retry';
  }

  return new InternalCompilerError(ICE.REQUEST, 'model request failed', {
    hint: 're-run with --verbose for details',
    detail: describe(err),
    cause: err,
  });
}

function degrade(strategy: Strategy, status: number, hintText: string): boolean {
  const mentions = (needle: string) => hintText.includes(needle);

  if (strategy.reasoning && strategy.reasoningParam) {
    const param = strategy.reasoningParam.toLowerCase();
    const compact = param.replace(/[_-]/g, ' ');
    if (hintText.includes(param) || hintText.includes(compact) || (status === 400 && hintText.includes('reasoning'))) {
      strategy.reasoning = false;
      return true;
    }
  }

  if (strategy.schema === 'json_schema' && (mentions('response_format') || mentions('json_schema') || mentions('structured') || mentions('schema'))) {
    strategy.schema = 'json_object';
    return true;
  }
  if (strategy.schema === 'json_object' && (mentions('response_format') || mentions('json_object') || mentions('json'))) {
    strategy.schema = 'off';
    return true;
  }
  if (strategy.streamOptions && (mentions('stream_options') || mentions('include_usage'))) {
    strategy.streamOptions = false;
    return true;
  }
  if (strategy.tokenField === 'max_tokens' && (mentions('max_tokens') || mentions('max_completion_tokens'))) {
    strategy.tokenField = 'max_completion_tokens';
    return true;
  }
  if (strategy.stream && mentions('stream')) {
    strategy.stream = false;
    strategy.streamOptions = false;
    return true;
  }

  if (status === 400 || status === 422) {
    if (strategy.schema === 'json_schema') {
      strategy.schema = 'json_object';
      return true;
    }
    if (strategy.schema === 'json_object') {
      strategy.schema = 'off';
      return true;
    }
    if (strategy.streamOptions) {
      strategy.streamOptions = false;
      return true;
    }
    if (strategy.stream) {
      strategy.stream = false;
      strategy.streamOptions = false;
      return true;
    }
  }
  return false;
}

async function consumeResponse(response: Response, options: ChatOptions, strategy: Strategy): Promise<RawCompletion> {
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();

  if (contentType.includes('text/event-stream')) {
    return consumeSseStream(response, options);
  }

  const text = await response.text();
  if (!text.trim()) throw new EmptyCompletion(null);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    if (text.includes('data:')) return consumeSseText(text, options);
    throw new InternalCompilerError(ICE.RESPONSE, 'model endpoint returned a non-JSON body', {
      hint: 'the baseUrl may not point at an OpenAI-compatible /chat/completions endpoint',
      detail: oneLine(text, 300),
    });
  }

  const extracted = extractPayload(parsed);
  return { ...extracted, streamed: false };
}

async function consumeSseStream(response: Response, options: ChatOptions): Promise<RawCompletion> {
  if (!response.body) throw new EmptyCompletion(null);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const state: MutableCompletion = { content: '', usage: null, finishReason: null };

  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = drainSseBuffer(buffer, state, options);
    }
    buffer += decoder.decode();
  } finally {
    try {
      reader.releaseLock();
    } catch {

    }
  }

  if (buffer.trim()) drainSseBuffer(`${buffer}\n`, state, options);
  return { content: state.content, usage: state.usage, finishReason: state.finishReason, streamed: true };
}

function consumeSseText(text: string, options: ChatOptions): RawCompletion {
  const state: MutableCompletion = { content: '', usage: null, finishReason: null };
  drainSseBuffer(`${text}\n`, state, options);
  return { content: state.content, usage: state.usage, finishReason: state.finishReason, streamed: true };
}

interface MutableCompletion {
  content: string;
  usage: Usage | null;
  finishReason: string | null;
}

function drainSseBuffer(buffer: string, state: MutableCompletion, options: ChatOptions): string {
  let rest = buffer;
  for (;;) {
    const newline = rest.indexOf('\n');
    if (newline < 0) break;
    const line = rest.slice(0, newline).replace(/\r$/, '');
    rest = rest.slice(newline + 1);
    if (!line || line.startsWith(':')) continue;
    if (!line.startsWith('data:')) continue;

    const payload = line.slice(5).trim();
    if (!payload) continue;
    if (payload === '[DONE]') return rest;

    let chunk: unknown;
    try {
      chunk = JSON.parse(payload);
    } catch {
      continue;
    }
    applyChunk(chunk, state, options);
  }
  return rest;
}

function applyChunk(chunk: unknown, state: MutableCompletion, options: ChatOptions): void {
  if (!isPlainObject(chunk)) return;

  if (chunk.error !== undefined && chunk.error !== null) {
    const message = isPlainObject(chunk.error) ? String(chunk.error.message ?? '') : String(chunk.error);
    throw new InternalCompilerError(ICE.REQUEST, 'model stream reported an error', {
      detail: oneLine(message, 500),
    });
  }

  const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
  if (isPlainObject(choice)) {
    const delta = isPlainObject(choice.delta) ? choice.delta : null;
    const message = isPlainObject(choice.message) ? choice.message : null;
    const text = delta
      ? contentToString(delta.content ?? delta.text)
      : message
        ? contentToString(message.content)
        : contentToString(choice.text);
    if (text) {
      state.content += text;
      options.onDelta?.(text, state.content.length);
    }
    if (typeof choice.finish_reason === 'string') state.finishReason = choice.finish_reason;
  }

  if (isPlainObject(chunk.usage)) state.usage = normalizeUsage(chunk.usage) ?? state.usage;

  if (!choice && isPlainObject(chunk.delta)) {
    const text = contentToString(chunk.delta.text);
    if (text) {
      state.content += text;
      options.onDelta?.(text, state.content.length);
    }
  }
}

function extractPayload(payload: unknown): Omit<RawCompletion, 'streamed'> {
  if (!isPlainObject(payload)) {
    throw new InternalCompilerError(ICE.RESPONSE, 'model endpoint returned an unexpected JSON document', {
      detail: oneLine(JSON.stringify(payload), 300),
    });
  }

  if (payload.error !== undefined && payload.error !== null) {
    const message = isPlainObject(payload.error) ? String(payload.error.message ?? '') : String(payload.error);
    throw new InternalCompilerError(ICE.REQUEST, 'model endpoint returned an error', {
      detail: oneLine(message, 500),
    });
  }

  const choice = Array.isArray(payload.choices) ? payload.choices[0] : undefined;
  let content = '';
  let finishReason: string | null = null;

  if (isPlainObject(choice)) {
    const message = isPlainObject(choice.message) ? choice.message : null;
    content = message ? contentToString(message.content) : contentToString(choice.text);
    if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason;
  }

  if (!content) content = contentToString(payload.output_text);
  if (!content) content = contentToString(payload.content);
  if (!content && typeof payload.message === 'string') content = payload.message;

  const usage = isPlainObject(payload.usage) ? normalizeUsage(payload.usage) : null;
  return { content, usage, finishReason };
}

function contentToString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    let out = '';
    for (const part of value) {
      if (typeof part === 'string') out += part;
      else if (isPlainObject(part)) out += contentToString(part.text ?? part.content);
    }
    return out;
  }
  if (isPlainObject(value)) return contentToString(value.text ?? value.content);
  return '';
}

function normalizeUsage(raw: Record<string, unknown>): Usage | null {
  const prompt = Number(raw.prompt_tokens ?? raw.input_tokens ?? 0);
  const completion = Number(raw.completion_tokens ?? raw.output_tokens ?? 0);
  const total = Number(raw.total_tokens ?? prompt + completion);
  if (!Number.isFinite(prompt) && !Number.isFinite(completion)) return null;
  return {
    promptTokens: Number.isFinite(prompt) ? prompt : 0,
    completionTokens: Number.isFinite(completion) ? completion : 0,
    totalTokens: Number.isFinite(total) ? total : 0,
  };
}

function extractErrorMessage(body: string): string {
  if (!body.trim()) return '(empty response body)';
  try {
    const parsed: unknown = JSON.parse(body);
    if (isPlainObject(parsed)) {
      if (typeof parsed.error === 'string') return parsed.error;
      if (isPlainObject(parsed.error) && typeof parsed.error.message === 'string') return parsed.error.message;
      if (typeof parsed.message === 'string') return parsed.message;
      if (typeof parsed.detail === 'string') return parsed.detail;
    }
    if (typeof parsed === 'string') return parsed;
  } catch {

  }
  return oneLine(body, 300);
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: string }).code ?? (err.cause as { code?: string } | undefined)?.code ?? '';
  if (
    ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT', 'ERR_TLS_CERT_ALTNAME_INVALID'].includes(
      code,
    )
  ) {
    return true;
  }
  return /fetch failed|network|socket hang up|terminated/i.test(err.message);
}

function backoffFor(attempt: number, err: unknown): number {
  if (err instanceof HttpError && err.retryAfterMs !== null) {
    return Math.min(MAX_BACKOFF_MS, err.retryAfterMs);
  }
  const base = Math.min(MAX_BACKOFF_MS, 400 * 2 ** (attempt - 1));
  return base + Math.floor(Math.random() * 250);
}

function describeStrategy(strategy: Strategy): string {
  const reasoning = strategy.reasoningParam ? `${strategy.reasoningParam}=${strategy.reasoning ? 'on' : 'off'}` : 'off';
  return `schema=${strategy.schema} stream=${strategy.stream} stream_options=${strategy.streamOptions} token=${strategy.tokenField} reasoning=${reasoning}`;
}

function describe(err: unknown): string {
  if (err instanceof HttpError) return `HTTP ${err.status}: ${truncate(extractErrorMessage(err.body), 200)}`;
  if (err instanceof Error) return err.message;
  return String(err);
}
