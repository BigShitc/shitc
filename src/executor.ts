import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { outputRoot } from './config.js';
import { ICE, InternalCompilerError } from './errors.js';
import type { GeneratedFile } from './schema.js';
import { buildShellInvocation, prepareCommand, type ShellInfo } from './shell.js';
import { artifactId, expandHome } from './util.js';

export interface WrittenFile {
  path: string;
  absolutePath: string;
  bytes: number;
}

const BUILD_DIR_PATTERN = /^\d{8}-\d{6}-[0-9a-z]{4}$/;
const KEEP_BUILD_DIRS = 20;

export function resolveOutputDir(explicit?: string): string {
  const requested = explicit?.trim();
  if (requested) return prepareOutputDir(path.resolve(expandHome(requested)));

  const root = outputRoot();
  if (process.env.SHITC_OUT_DIR?.trim() || process.env.SHITC_ARTIFACT_DIR?.trim()) {
    return prepareOutputDir(root);
  }

  prepareOutputDir(root);
  let dir = '';
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 5 && !dir; attempt += 1) {
    const candidate = path.join(root, artifactId());
    try {
      mkdirSync(candidate, { recursive: false, mode: 0o700 });
      dir = candidate;
    } catch (cause) {
      lastError = cause;

      if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') break;
    }
  }
  if (!dir) {
    throw new InternalCompilerError(ICE.WRITE, `cannot create a build directory under ${root}`, {
      hint: 'set SHITC_OUT_DIR to a writable directory, or pass -o <dir>',
      cause: lastError,
    });
  }
  pruneBuildDirs(root);
  return dir;
}

export function pruneBuildDirs(root: string, keep = KEEP_BUILD_DIRS): void {
  try {
    const entries = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && BUILD_DIR_PATTERN.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .reverse();

    for (const name of entries.slice(keep)) {
      rmSync(path.join(root, name), { recursive: true, force: true });
    }
  } catch {

  }
}

export function prepareOutputDir(dir: string): string {
  try {
    mkdirSync(dir, { recursive: true });
    const stats = statSync(dir);
    if (!stats.isDirectory()) {
      throw new InternalCompilerError(ICE.WRITE, `output path is not a directory: ${dir}`, {
        hint: 'pass -o <dir> with a directory path',
      });
    }
    return dir;
  } catch (cause) {
    if (cause instanceof InternalCompilerError) throw cause;
    throw new InternalCompilerError(ICE.WRITE, `cannot use output directory ${dir}`, {
      hint: 'check permissions, or pass -o <dir>',
      cause,
    });
  }
}

export function writeArtifacts(dir: string, files: GeneratedFile[]): WrittenFile[] {
  const base = path.resolve(dir);
  const written: WrittenFile[] = [];

  for (const file of files) {
    const absolutePath = path.resolve(base, file.path);
    const relative = path.relative(base, absolutePath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new InternalCompilerError(ICE.UNSAFE_PATH, `refusing to write outside the output directory: ${file.path}`, {
        hint: 'this should have been rejected by the IR validator; report a bug',
      });
    }

    try {
      mkdirSync(path.dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, file.content, { encoding: 'utf8', mode: 0o644 });
      if (process.platform !== 'win32') {
        try {
          chmodSync(absolutePath, 0o644);
        } catch {

        }
      }
      written.push({ path: file.path, absolutePath, bytes: statSync(absolutePath).size });
    } catch (cause) {
      throw new InternalCompilerError(ICE.WRITE, `cannot write generated file "${file.path}"`, {
        hint: 'check available disk space and permissions',
        cause,
      });
    }
  }

  return written;
}

export function findRunArtifact(buildDir: string, runCommand: string): string | null {
  const firstToken = runCommand.trim().split(/[\s;&|<>]+/)[0] ?? '';
  const token = firstToken.replace(/^["']|["']$/g, '');
  if (!token || token.startsWith('-')) return null;

  const candidates = [token, token.replace(/^\.\//, ''), token.replace(/^\.\\/, '')];
  if (process.platform === 'win32') {
    const base = [...candidates];
    for (const candidate of base) {
      if (!candidate.toLowerCase().endsWith('.exe')) candidates.push(`${candidate}.exe`);
    }
  }

  for (const candidate of candidates) {
    if (!candidate || path.isAbsolute(candidate)) continue;
    const absolute = path.resolve(buildDir, candidate);
    const relative = path.relative(buildDir, absolute);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
    try {
      if (statSync(absolute).isFile()) return relative;
    } catch {

    }
  }
  return null;
}

export function exportArtifact(buildDir: string, relativePath: string, targetDir: string): string {
  const targetBase = path.resolve(targetDir);
  const source = path.resolve(buildDir, relativePath);
  const target = path.resolve(targetBase, relativePath);
  const relativeTarget = path.relative(targetBase, target);
  if (!relativeTarget || relativeTarget.startsWith('..') || path.isAbsolute(relativeTarget)) {
    throw new InternalCompilerError(ICE.UNSAFE_PATH, `refusing to export outside ${targetBase}`);
  }

  try {
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(source, target);
    if (process.platform !== 'win32') {
      try {
        chmodSync(target, statSync(source).mode);
      } catch {

      }
    }
    return target;
  } catch (cause) {
    throw new InternalCompilerError(ICE.WRITE, `cannot export ${relativePath} to ${targetBase}`, {
      hint: 'check permissions, or pass -o <dir>',
      cause,
    });
  }
}

export function exportArtifactFile(buildDir: string, relativePath: string, targetFile: string): string {
  const source = path.resolve(buildDir, relativePath);
  let target = path.resolve(targetFile);
  if (process.platform === 'win32' && !target.toLowerCase().endsWith('.exe')) target = `${target}.exe`;

  try {
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(source, target);
    if (process.platform !== 'win32') {
      try {
        chmodSync(target, statSync(source).mode);
      } catch {

      }
    }
    return target;
  } catch (cause) {
    throw new InternalCompilerError(ICE.WRITE, `cannot export ${relativePath} to ${target}`, {
      hint: 'check permissions, or pass -o <file>',
      cause,
    });
  }
}

export function removeBuiltArtifact(buildDir: string, relativePath: string): void {
  try {
    const base = path.resolve(buildDir);
    const target = path.resolve(base, relativePath);
    const relative = path.relative(base, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return;
    rmSync(target, { force: true });
  } catch {

  }
}

export type StageName = 'compile' | 'run';

export interface StageResult {
  name: StageName;
  command: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;

  succeeded: boolean;
}

export interface RunStageOptions {
  name: StageName;
  command: string;
  cwd: string;
  shell: ShellInfo;
  timeoutMs: number;

  live: boolean;
  signal?: AbortSignal;
}

export function runStage(options: RunStageOptions): Promise<StageResult> {
  const { name, command, cwd, shell, timeoutMs, live } = options;
  const prepared = prepareCommand(command, shell);
  const invocation = buildShellInvocation(prepared, shell);
  const startedAt = Date.now();
  const stdout = new OutputCapture();
  const stderr = new OutputCapture();

  return new Promise<StageResult>((resolve, reject) => {
    let settled = false;
    let timedOut = false;

    const grouped = process.platform !== 'win32';
    const child = spawn(invocation.file, invocation.args, {
      cwd,
      env: childEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: grouped,
    });

    const signalTree = (signal: NodeJS.Signals): void => {
      if (grouped && typeof child.pid === 'number') {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {

        }
      }
      try {
        child.kill(signal);
      } catch {

      }
    };

    const killTimer = (): void => {
      signalTree('SIGTERM');
      const escalate = setTimeout(() => signalTree('SIGKILL'), 1500);
      escalate.unref?.();
    };

    const onAbort = (): void => killTimer();
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const timer = setTimeout(() => {
      timedOut = true;
      killTimer();
    }, timeoutMs);
    timer.unref?.();

    const cleanup = (): void => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout.push(chunk);
      if (live) process.stdout.write(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr.push(chunk);
      if (live) process.stderr.write(chunk);
    });

    child.on('error', (cause) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        new InternalCompilerError(ICE.EXEC, `cannot start ${name} stage (${invocation.file})`, {
          hint: 'the detected shell executable may be missing; pass --shell or set SHITC_SHELL',
          cause,
        }),
      );
    });

    child.on('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        name,
        command,
        exitCode,
        signal,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        durationMs: Date.now() - startedAt,
        timedOut,
        truncated: stdout.truncated || stderr.truncated,
        succeeded: !timedOut && signal === null && exitCode === 0,
      });
    });
  });
}

function childEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PYTHONUNBUFFERED: '1',
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    NODE_OPTIONS: stripNodeOptions(process.env.NODE_OPTIONS),
  };
}

function stripNodeOptions(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const filtered = value
    .split(/\s+/)
    .filter((flag) => !/^--(import|require|loader|experimental-loader|test|inspect)/.test(flag))
    .join(' ')
    .trim();
  return filtered || undefined;
}

export class OutputCapture {
  private head: Buffer[] = [];
  private headSize = 0;
  private tail: Buffer[] = [];
  private tailSize = 0;
  total = 0;
  truncated = false;
  private readonly headLimit: number;
  private readonly tailLimit: number;

  constructor(headLimit = 64 * 1024, tailLimit = 192 * 1024) {
    this.headLimit = headLimit;
    this.tailLimit = tailLimit;
  }

  push(chunk: Buffer): void {
    this.total += chunk.length;

    if (this.headSize < this.headLimit) {
      const take = Math.min(chunk.length, this.headLimit - this.headSize);
      this.head.push(chunk.subarray(0, take));
      this.headSize += take;
      if (take === chunk.length) return;
      chunk = chunk.subarray(take);
    }

    this.truncated = true;
    this.tail.push(chunk);
    this.tailSize += chunk.length;
    while (this.tailSize > this.tailLimit) {
      const first = this.tail[0];
      if (!first) break;
      const excess = this.tailSize - this.tailLimit;
      if (first.length <= excess) {
        this.tail.shift();
        this.tailSize -= first.length;
      } else {
        this.tail[0] = first.subarray(excess);
        this.tailSize -= excess;
      }
    }
  }

  toString(): string {
    const head = Buffer.concat(this.head).toString('utf8');
    if (!this.truncated) return head;
    const tail = Buffer.concat(this.tail).toString('utf8');
    return `${head}\n… output truncated (${this.total} bytes total) …\n${tail}`;
  }
}
