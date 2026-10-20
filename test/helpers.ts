import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import process from 'node:process';

export const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');

export interface MockRequest {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: Record<string, unknown>;
  raw: string;
}

export interface MockReply {
  status?: number;

  body?: unknown;

  sse?: string[];
  contentType?: string;
  delayMs?: number;
  headers?: Record<string, string>;
}

export type MockHandler = (request: MockRequest, response: ServerResponse) => MockReply | void | Promise<MockReply | void>;

export interface MockServer {
  url: string;
  requests: MockRequest[];
  close: () => Promise<void>;
}

export async function startMockServer(handler: MockHandler): Promise<MockServer> {
  const requests: MockRequest[] = [];

  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString('utf8');

    let body: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(raw);
      body = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch {
      body = {};
    }

    const request: MockRequest = { method: req.method ?? 'GET', url: req.url ?? '/', headers: req.headers, body, raw };
    requests.push(request);

    const reply = await handler(request, res);
    if (!reply) return;

    if (reply.delayMs) await new Promise((resolve) => setTimeout(resolve, reply.delayMs));

    if (reply.sse) {
      res.writeHead(reply.status ?? 200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        ...reply.headers,
      });
      for (const chunk of reply.sse) res.write(`data: ${chunk}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    res.writeHead(reply.status ?? 200, { 'content-type': reply.contentType ?? 'application/json', ...reply.headers });
    res.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {}));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

export function sseContent(content: string, chunkSize = 12): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < content.length; index += chunkSize) {
    chunks.push(JSON.stringify({ choices: [{ delta: { content: content.slice(index, index + chunkSize) } }] }));
  }
  return chunks;
}

export function sseReply(content: string): MockReply {
  return {
    sse: [
      ...sseContent(content),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } }),
    ],
  };
}

export function jsonReply(content: string): MockReply {
  return { body: { choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 } } };
}

export function makeTempDir(prefix = 'shitc-test-'): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export interface CliRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface RunCliOptions {
  env?: Record<string, string>;
  stdin?: string;
  cwd?: string;
  timeoutMs?: number;

  built?: boolean;
}

export function runCli(args: string[], options: RunCliOptions = {}): Promise<CliRun> {
  const tsxLoader = path.join(PROJECT_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs');
  const command = options.built
    ? [path.join(PROJECT_ROOT, 'dist/cli.js'), ...args]
    : ['--import', tsxLoader, path.join(PROJECT_ROOT, 'src/cli.ts'), ...args];

  return new Promise<CliRun>((resolve, reject) => {
    const child = spawn(process.execPath, command, {
      cwd: options.cwd ?? PROJECT_ROOT,
      env: {
        ...process.env,
        NO_COLOR: '1',
        FORCE_COLOR: '0',
        SHITC_CONFIG_DIR: '',
        SHITC_ARTIFACT_DIR: '',
        SHITC_OUT_DIR: '',
        SHITC_SHELL: '',
        ...options.env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`CLI timed out after ${options.timeoutMs ?? 30_000}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, options.timeoutMs ?? 30_000);
    timer.unref?.();

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({ code, stdout, stderr });
    });

    if (options.stdin !== undefined) child.stdin.end(options.stdin);
    else child.stdin.end();
  });
}

export function planFor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    language: 'javascript',
    runtimeKind: 'interpreted',
    compileCommand: '',
    runCommand: 'node main.js',
    files: [{ path: 'main.js', content: 'console.log("hello from shitc");\n' }],
    entry: 'main.js',
    notes: 'compiled to node',
    ...overrides,
  };
}
