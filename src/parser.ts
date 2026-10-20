import { ICE, InternalCompilerError, SourceError, type SourceDiagnostic } from './errors.js';
import type { GeneratedFile, PlanStatus, ProgramPlan, RuntimeKind } from './schema.js';
import { isPlainObject, oneLine, truncate } from './util.js';

const MAX_FILE_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_PATH_LENGTH = 200;

const INTERPRETED_SYNONYMS = new Set(['interpreted', 'interpreted_script', 'script', 'run', 'executed', 'interpreted-script']);
const COMPILED_SYNONYMS = new Set(['compiled', 'compile', 'build', 'binary', 'aot', 'jit-compiled', 'native']);

const EXTENSION_LANGUAGE: Record<string, string> = {
  py: 'python',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  rs: 'rust',
  go: 'go',
  java: 'java',
  cs: 'csharp',
  rb: 'ruby',
  php: 'php',
  pl: 'perl',
  lua: 'lua',
  swift: 'swift',
  zig: 'zig',
  dart: 'dart',
  jl: 'julia',
  r: 'r',
  ex: 'elixir',
  exs: 'elixir',
  hs: 'haskell',
  nim: 'nim',
  kt: 'kotlin',
  kts: 'kotlin',
  scala: 'scala',
  sh: 'bash',
  bash: 'bash',
  ps1: 'powershell',
};

const DEFAULT_FILENAME: Record<string, string> = {
  python: 'main.py',
  javascript: 'main.js',
  typescript: 'main.ts',
  c: 'main.c',
  cpp: 'main.cpp',
  rust: 'main.rs',
  go: 'main.go',
  java: 'Main.java',
  csharp: 'Program.cs',
  ruby: 'main.rb',
  php: 'main.php',
  lua: 'main.lua',
  swift: 'main.swift',
  zig: 'main.zig',
  kotlin: 'Main.kt',
  bash: 'main.sh',
  powershell: 'main.ps1',
};

const DESTRUCTIVE_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\brm\s+(?:-{1,2}\S+\s+)*\/(?:\*)?(?=\s|$|[;&|])/, label: 'recursive delete of /' },
  { re: /\brm\s+(?:-{1,2}\S+\s+)*(?:~\/?)(?=\s|$|[;&|])/, label: 'recursive delete of home' },
  { re: /\brm\s+(?:-{1,2}\S+\s+)*\/(?:bin|etc|usr|var|boot|home|dev|lib|opt|srv|sys|proc|root)\b/, label: 'delete of a system directory' },
  { re: /\bdel\s+\/[a-zA-Z]*[sq][a-zA-Z]*\s+[a-zA-Z]:\\?\s*(?:$|[&|])/i, label: 'delete of a drive root' },
  { re: /\brd\s+\/s\s+\/q\s+[a-zA-Z]:\\?\s*(?:$|[&|])/i, label: 'delete of a drive root' },
  { re: /\bformat\s+[a-zA-Z]:/i, label: 'disk format' },
  { re: /\bmkfs(?:\.\w+)?\b/, label: 'filesystem creation on a device' },
  { re: /\bdd\b[^|;&]*\bof=\/dev\/[sh]d/, label: 'raw disk write' },
  { re: /\bof=\/dev\/(?:sd|nvme|disk)/, label: 'raw disk write' },
  { re: /:\(\)\s*\{\s*:\|:&\s*\};:/, label: 'fork bomb' },
  { re: /\b(?:shutdown|reboot|halt|poweroff)\b/, label: 'machine shutdown' },
  { re: /\bStop-Computer\b|\bRestart-Computer\b/i, label: 'machine shutdown' },
  { re: /\bchmod\s+-R\s+[0-7]{3,4}\s+\/(?:\s|$)/, label: 'recursive chmod of /' },
  { re: /\bchown\s+-R\b[^|;&]*\s\/(?:\s|$)/, label: 'recursive chown of /' },
  { re: /\b(?:curl|wget)\b[^|;&]*\|\s*(?:sudo\s+)?(?:ba|z|k)?sh\b/, label: 'piping remote content into a shell' },
  { re: /\bRemove-Item\b[^|;&]*-Recurse[^|;&]*[a-zA-Z]:\\?\s*(?:$|[;&|])/i, label: 'recursive delete of a drive root' },
  { re: /(?:^|[\s"'=(])(?:\.\.\/|\.\.\\)/, label: 'path escaping the working directory' },
];

export interface ParseStats {

  via: 'direct' | 'fence' | 'scan' | 'repaired';
}

export interface JsonCandidate {
  text: string;
  via: 'direct' | 'fence' | 'scan';
}

export interface ParsedPlan {
  plan: ProgramPlan;
  stats: ParseStats;
}

export function parsePlan(raw: string): ProgramPlan {
  return parsePlanDetailed(raw).plan;
}

export function parsePlanDetailed(raw: string): ParsedPlan {
  const text = raw?.trim() ?? '';
  if (!text) {
    throw new InternalCompilerError(ICE.RESPONSE, 'model returned an empty response', {
      hint: 'try a different model, or raise maxTokens',
    });
  }

  const candidates = extractJsonObjects(text);
  if (candidates.length === 0) {
    throw new InternalCompilerError(ICE.RESPONSE, 'model response did not contain a JSON object', {
      hint: 'the provider may have ignored the JSON instructions; try a stronger model',
      detail: oneLine(text, 400),
    });
  }

  const errors: InternalCompilerError[] = [];
  const failures: string[] = [];
  let sawJson = false;
  let index = 0;

  for (const candidate of candidates) {
    index += 1;
    let parsed: unknown;
    let via: ParseStats['via'] = candidate.via;

    try {
      parsed = JSON.parse(candidate.text);
    } catch {
      try {
        parsed = JSON.parse(repairJson(candidate.text));
        via = 'repaired';
      } catch (cause) {
        failures.push(`candidate #${index}: not valid JSON (${(cause as Error).message})`);
        continue;
      }
    }

    sawJson = true;
    const envelope = unwrapEnvelope(parsed);
    if (!envelope) {
      failures.push(`candidate #${index}: JSON object is not a program envelope`);
      continue;
    }

    try {

      const rejection = extractRejection(envelope);
      if (rejection) throw new SourceError('<source>', rejection);
      const plan = normalizePlan(envelope);
      return { plan, stats: { via } };
    } catch (err) {
      if (err instanceof SourceError) throw err;
      if (err instanceof InternalCompilerError) {

        if (err.code === ICE.UNSAFE_PATH || err.code === ICE.UNSAFE_COMMAND) throw err;
        errors.push(err);
        failures.push(`${err.code}: ${err.message}`);
        continue;
      }
      throw err;
    }
  }

  if (errors.length > 0) throw errors[0]!;

  if (sawJson) {
    throw new InternalCompilerError(ICE.IR, failures[0] ?? 'no candidate matched the ShitLang IR', {
      hint: 're-run with --verbose to inspect the raw model response',
      detail: failures.length > 1 ? failures.slice(1).join('\n') : undefined,
    });
  }

  throw new InternalCompilerError(ICE.RESPONSE, 'model response is not valid JSON', {
    hint: 'the provider may not support JSON output; try a stronger model or --verbose',
    detail: truncate(text, 400),
  });
}

function normalizeStatus(envelope: Record<string, unknown>): PlanStatus | null {
  const raw = pickFirst(envelope, ['status', 'result', 'state', 'verdict']);
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  if (['ok', 'valid', 'success', 'accepted', 'compiled', 'code'].includes(value)) return 'ok';
  if (['invalid', 'error', 'rejected', 'refused', 'syntax_error', 'syntax-error', 'not_code', 'not-code'].includes(value)) {
    return 'invalid';
  }
  return null;
}

export function extractRejection(envelope: Record<string, unknown>): SourceDiagnostic[] | null {
  const status = normalizeStatus(envelope);
  const diagnostics = normalizeDiagnostics(envelope);

  if (status !== 'invalid' && diagnostics.length === 0) return null;

  if (diagnostics.length === 0) {
    const fallback =
      pickString(envelope, ['message', 'reason', 'error', 'notes', 'note']) ?? 'this is not a ShitLang program';
    return [{ line: 1, message: fallback.trim() }];
  }
  return diagnostics;
}

function normalizeDiagnostics(envelope: Record<string, unknown>): SourceDiagnostic[] {
  const raw = pickFirst(envelope, ['diagnostics', 'errors', 'issues', 'problems']);
  const items: unknown[] = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const out: SourceDiagnostic[] = [];

  for (const item of items) {
    if (typeof item === 'string' && item.trim()) {
      out.push({ line: 1, message: item.trim() });
      continue;
    }
    if (!isPlainObject(item)) continue;

    const message = pickString(item, ['message', 'error', 'msg', 'text', 'reason', 'detail']);
    if (!message || !message.trim()) continue;

    const lineValue = pickFirst(item, ['line', 'ln', 'lineNumber', 'line_number']);
    const line = typeof lineValue === 'number' && Number.isFinite(lineValue) && lineValue >= 1 ? Math.floor(lineValue) : 1;
    const hint = pickString(item, ['hint', 'help', 'suggestion']);
    const diagnostic: SourceDiagnostic = { line, message: message.trim() };
    if (hint && hint.trim()) diagnostic.hint = hint.trim();
    out.push(diagnostic);
  }

  const seen = new Set<string>();
  const unique: SourceDiagnostic[] = [];
  for (const diagnostic of out) {
    const key = `${diagnostic.line}:${diagnostic.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(diagnostic);
  }
  return unique.slice(0, 20);
}

export function extractJsonObjects(text: string): JsonCandidate[] {
  const trimmed = text.trim();
  const found: JsonCandidate[] = [];

  if (trimmed.startsWith('{') && trimmed.endsWith('}')) found.push({ text: trimmed, via: 'direct' });

  const fence = /```[a-zA-Z0-9_+-]*[ \t]*\r?\n([\s\S]*?)```/g;
  for (const match of trimmed.matchAll(fence)) {
    const inner = match[1]?.trim();
    if (inner) found.push({ text: inner, via: 'fence' });
  }

  for (const object of scanBalancedObjects(trimmed)) found.push({ text: object, via: 'scan' });

  const unique: JsonCandidate[] = [];
  const seen = new Set<string>();
  for (const candidate of found) {
    const value = candidate.text.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    unique.push({ text: value, via: candidate.via });
  }
  return unique;
}

export function scanBalancedObjects(text: string): string[] {
  const objects: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (ch === '}') {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0 && start >= 0) {
        objects.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return objects;
}

function repairJson(text: string): string {
  let out = text.trim();
  out = out.replace(/,\s*([}\]])/g, '$1');
  out = out.replace(/^\uFEFF/, '');
  return out;
}

function unwrapEnvelope(parsed: unknown): Record<string, unknown> | null {
  if (!isPlainObject(parsed)) return null;
  if (isPlainObject(parsed.plan)) return parsed.plan;
  if (isPlainObject(parsed.result)) return parsed.result;
  if (isPlainObject(parsed.data)) return parsed.data;
  if (isPlainObject(parsed.output)) return parsed.output;
  return parsed;
}

function normalizePlan(envelope: Record<string, unknown>): ProgramPlan {
  const language = inferLanguage(envelope);
  const files = normalizeFiles(envelope, language);
  if (files.length === 0) {
    throw new InternalCompilerError(ICE.EMPTY_PROGRAM, 'model returned no program files', {
      hint: 'the model may have refused or truncated; try again or use a different model',
    });
  }

  const compileCommand = normalizeCommand(
    pickFirst(envelope, ['compileCommand', 'compile_command', 'compile_cmd', 'buildCommand', 'build_command', 'build']),
    'compileCommand',
  );
  const runCommand = normalizeCommand(
    pickFirst(envelope, ['runCommand', 'run_command', 'run_cmd', 'executeCommand', 'execute', 'run']),
    'runCommand',
  );

  if (!runCommand) {
    throw new InternalCompilerError(ICE.MISSING_COMMAND, 'model returned no runCommand', {
      hint: 're-run; if it persists, pick a model with better instruction following',
    });
  }

  const declaredKind = normalizeRuntimeKind(pickFirst(envelope, ['runtimeKind', 'runtime_kind', 'runtime', 'kind', 'executionMode']));

  const runtimeKind: RuntimeKind = compileCommand ? 'compiled' : declaredKind ?? 'interpreted';

  if (runtimeKind === 'compiled' && !compileCommand) {
    throw new InternalCompilerError(ICE.MISSING_COMMAND, 'model declared a compiled target but returned no compileCommand', {
      hint: 're-run; shitc requires a build command for compiled languages',
    });
  }

  const entry = normalizeEntry(envelope, files);
  const notes = pickString(envelope, ['notes', 'note', 'explanation', 'comment', 'summary']) ?? '';

  assertCommandsSafe(compileCommand, runCommand);

  return {
    language,
    runtimeKind,
    compileCommand,
    runCommand,
    files,
    entry,
    notes: notes.trim(),
  };
}

function normalizeFiles(envelope: Record<string, unknown>, language: string): GeneratedFile[] {
  const rawFiles = envelope.files ?? envelope.sources ?? envelope.artifacts;
  const files: GeneratedFile[] = [];

  if (Array.isArray(rawFiles)) {
    for (const raw of rawFiles) {
      if (!isPlainObject(raw)) {
        throw new InternalCompilerError(ICE.IR, 'files[] entries must be objects with "path" and "content"', {
          detail: oneLine(JSON.stringify(raw), 200),
        });
      }
      const pathValue = pickString(raw, ['path', 'file', 'filename', 'name']) ?? pickString(raw, ['entry']);
      const contentValue = pickContent(raw);
      if (!pathValue) {
        throw new InternalCompilerError(ICE.IR, 'a file entry is missing its "path"');
      }
      if (contentValue === null) {
        throw new InternalCompilerError(ICE.IR, `file "${pathValue}" is missing its "content"`);
      }
      files.push({ path: normalizeRelPath(pathValue), content: contentValue });
    }
  } else if (isPlainObject(rawFiles)) {

    for (const [key, value] of Object.entries(rawFiles)) {
      if (typeof value !== 'string') {
        throw new InternalCompilerError(ICE.IR, `files["${key}"] must be a string`);
      }
      files.push({ path: normalizeRelPath(key), content: value });
    }
  } else if (Array.isArray(envelope.code)) {
    for (let i = 0; i < envelope.code.length; i += 1) {
      const value = envelope.code[i];
      if (typeof value !== 'string') continue;
      files.push({ path: `main-${i + 1}${extensionFor(language)}`, content: value });
    }
  }

  if (files.length === 0) {
    const single = pickFirst(envelope, ['content', 'code', 'source', 'program', 'implementation']);
    if (typeof single === 'string' && single.trim()) {
      const entryName = fileNameFromEntry(pickString(envelope, ['entry', 'main', 'entrypoint', 'filename']), language);
      files.push({ path: entryName, content: single });
    }
  }

  const seen = new Set<string>();
  let totalBytes = 0;
  for (const file of files) {
    if (seen.has(file.path)) {
      throw new InternalCompilerError(ICE.IR, `duplicate file path "${file.path}"`);
    }
    seen.add(file.path);

    const bytes = Buffer.byteLength(file.content, 'utf8');
    if (bytes > MAX_FILE_BYTES) {
      throw new InternalCompilerError(ICE.IR, `file "${file.path}" is too large (${bytes} bytes)`, {
        hint: `keep generated files under ${MAX_FILE_BYTES} bytes`,
      });
    }
    totalBytes += bytes;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new InternalCompilerError(ICE.IR, 'generated program is too large', {
        hint: `total generated size must stay under ${MAX_TOTAL_BYTES} bytes`,
      });
    }
    if (!file.content.trim()) {
      throw new InternalCompilerError(ICE.IR, `file "${file.path}" is empty`);
    }
  }

  return files;
}

function pickContent(raw: Record<string, unknown>): string | null {
  for (const key of ['content', 'text', 'source', 'code', 'data', 'body']) {
    const value = raw[key];
    if (typeof value === 'string') return value;
  }
  return null;
}

function normalizeEntry(envelope: Record<string, unknown>, files: GeneratedFile[]): string {
  const available = files.map((file) => file.path);
  const raw = pickString(envelope, ['entry', 'main', 'entrypoint', 'entryPoint', 'mainFile', 'main_file']);
  const unique = available.length === 1 ? available[0]! : null;

  if (!raw) {
    if (unique) return unique;
    throw new InternalCompilerError(ICE.IR, `model did not declare an entry file (files: ${available.join(', ')})`, {
      hint: 'the IR requires "entry" to name one of files[].path',
    });
  }

  const entryCandidates = [raw, raw.replace(/^\.\//, '').replace(/^\.\\/, '')];
  for (const candidate of entryCandidates) {
    const normalized = tryNormalizeRelPath(candidate);
    if (normalized && available.includes(normalized)) return normalized;
  }

  const base = raw.replace(/\\/g, '/').split('/').pop() ?? raw;
  const basenameMatches = available.filter((path) => (path.split('/').pop() ?? path) === base);
  if (basenameMatches.length === 1) return basenameMatches[0]!;
  if (unique) return unique;

  throw new InternalCompilerError(ICE.IR, `entry "${raw}" is not one of the generated files (${available.join(', ')})`, {
    hint: 'the IR requires "entry" to name one of files[].path',
  });
}

function inferLanguage(envelope: Record<string, unknown>): string {
  const declared = pickString(envelope, ['language', 'lang', 'targetLanguage', 'target', 'target_language']);
  if (declared) return declared.trim().toLowerCase();

  const entry = pickString(envelope, ['entry', 'main', 'entrypoint', 'filename']);
  if (entry) {
    const ext = entry.split('.').pop()?.toLowerCase();
    if (ext && EXTENSION_LANGUAGE[ext]) return EXTENSION_LANGUAGE[ext]!;
  }

  const files = envelope.files;
  if (Array.isArray(files) && isPlainObject(files[0])) {
    const path = pickString(files[0], ['path', 'file', 'filename']);
    const ext = path?.split('.').pop()?.toLowerCase();
    if (ext && EXTENSION_LANGUAGE[ext]) return EXTENSION_LANGUAGE[ext]!;
  }

  const run = pickFirst(envelope, ['runCommand', 'run_command', 'run']);
  if (typeof run === 'string') {
    if (/\bpython3?\b/.test(run)) return 'python';
    if (/\bnode\b/.test(run)) return 'javascript';
    if (/\bbun\b/.test(run)) return 'javascript';
    if (/\bdeno\b/.test(run)) return 'typescript';
    if (/\bruby\b/.test(run)) return 'ruby';
    if (/\bphp\b/.test(run)) return 'php';
    if (/\bjava\b/.test(run)) return 'java';
    if (/\bgo\s+run\b/.test(run)) return 'go';
    if (/\btsx\b|\bts-node\b/.test(run)) return 'typescript';
  }

  const build = pickFirst(envelope, ['compileCommand', 'compile_command', 'build']);
  if (typeof build === 'string') {
    if (/\bgcc\b|\bcc\b/.test(build)) return 'c';
    if (/\bg\+\+\b|\bclang\+\+\b/.test(build)) return 'cpp';
    if (/\brustc\b/.test(build)) return 'rust';
    if (/\bgo\s+build\b/.test(build)) return 'go';
    if (/\bjavac\b/.test(build)) return 'java';
  }

  return 'unknown';
}

function normalizeRuntimeKind(value: unknown): RuntimeKind | null {
  if (typeof value !== 'string') return null;
  const kind = value.trim().toLowerCase();
  if (INTERPRETED_SYNONYMS.has(kind)) return 'interpreted';
  if (COMPILED_SYNONYMS.has(kind)) return 'compiled';
  if (/^compil/.test(kind)) return 'compiled';
  if (/^interpret/.test(kind)) return 'interpreted';
  return null;
}

function normalizeCommand(value: unknown, field: string): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    throw new InternalCompilerError(ICE.IR, `${field} must be a string`);
  }
  let command = value.replace(/\r\n?/g, '\n').trim();
  command = command.replace(/^\$\s+/, ''); 
  if (/^(?:none|n\/a|null|nil|empty|-)$/i.test(command)) return '';
  if (command.includes('\u0000')) {
    throw new InternalCompilerError(ICE.IR, `${field} contains a NUL byte`);
  }
  if (command.length > 4000) {
    throw new InternalCompilerError(ICE.IR, `${field} is unreasonably long`);
  }

  return command.trim();
}

function assertCommandsSafe(compileCommand: string, runCommand: string): void {
  for (const [field, command] of [
    ['compileCommand', compileCommand],
    ['runCommand', runCommand],
  ] as const) {
    if (!command) continue;
    for (const { re, label } of DESTRUCTIVE_PATTERNS) {
      if (re.test(command)) {
        throw new InternalCompilerError(ICE.UNSAFE_COMMAND, `refusing to execute ${field}: ${label}`, {
          hint: 'the model emitted a destructive command; shitc refuses to run it',
          detail: oneLine(command, 300),
        });
      }
    }
  }
}

export function normalizeRelPath(raw: string): string {
  const normalized = tryNormalizeRelPath(raw);
  if (normalized === null) {
    throw new InternalCompilerError(ICE.UNSAFE_PATH, `unsafe output path "${oneLine(raw, 120)}"`, {
      hint: 'generated files must use relative paths inside the working directory',
    });
  }
  return normalized;
}

export function tryNormalizeRelPath(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  let path = raw.trim().replace(/\\/g, '/');
  if (!path) return null;
  if (path.includes('\u0000') || /[\u0000-\u001f]/.test(path)) return null;

  if (path.startsWith('/') || /^[a-zA-Z]:/.test(path) || path.startsWith('//') || path.startsWith('~')) return null;

  const segments = path.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.length === 0) return null;
  if (segments.some((segment) => segment === '..')) return null;
  if (segments.some((segment) => segment.length > 120)) return null;

  path = segments.join('/');
  if (path.length > MAX_PATH_LENGTH) return null;
  return path;
}

function pickFirst(envelope: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (envelope[key] !== undefined && envelope[key] !== null) return envelope[key];
  }
  return undefined;
}

function pickString(envelope: Record<string, unknown>, keys: string[]): string | undefined {
  const value = pickFirst(envelope, keys);
  return typeof value === 'string' ? value : undefined;
}

function extensionFor(language: string): string {
  const name = DEFAULT_FILENAME[language];
  if (name) return name.slice(name.indexOf('.'));
  return '.txt';
}

function fileNameFromEntry(rawEntry: string | undefined, language: string): string {
  if (rawEntry) {
    const normalized = tryNormalizeRelPath(rawEntry);
    if (normalized) return normalized;
  }
  return DEFAULT_FILENAME[language] ?? `main${extensionFor(language)}`;
}
