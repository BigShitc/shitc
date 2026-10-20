#!/usr/bin/env node
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { compile, type CompileMode, type CompileResult } from './compiler.js';
import {
  configDir,
  configPath,
  outputRoot,
  describeConfig,
  inspectConfig,
  loadConfig,
  normalizeKey,
  parseConfigAssignment,
  saveConfig,
  type ShitcConfig,
} from './config.js';
import {
  EXIT,
  ICE_TITLES,
  InputError,
  InternalCompilerError,
  InterruptedError,
  ShitcError,
  SourceError,
  UsageError,
} from './errors.js';
import { runInit } from './init.js';
import { runModelsCommand } from './models.js';
import { detectShell, shellExecForm } from './shell.js';
import { detectToolchains, formatToolchains } from './toolchains.js';
import { Ui, color, symbol } from './ui.js';
import { formatDuration, formatBytes, isLoopbackUrl, maskSecret, oneLine, stripAnsi } from './util.js';
import { PROGRAM, TAGLINE, VERSION } from './version.js';

for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') process.exit(EXIT.OK);
    throw err;
  });
}

const COMMANDS = new Set(['run', 'init', 'config', 'doctor', 'models', 'help']);
const MAX_SOURCE_BYTES = 1024 * 1024;

interface CliOptions {
  lang?: string;
  emitOnly?: boolean;

  sourceOnly?: boolean;

  outPath?: string;

  outDir?: string;
  noStream?: boolean;
  json?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  temperature?: number;
  maxTokens?: number;

  reasoning?: string;
  shell?: string;
  force?: boolean;
  reveal?: boolean;
  log?: boolean;
}

interface ParsedArgs {
  command: string | null;
  positionals: string[];
  options: CliOptions;
  help: boolean;
  version: boolean;
}

const VALUED_FLAGS = new Set([
  '--lang',
  '--out',
  '--out-dir',
  '--model',
  '--base-url',
  '--api-key',
  '--timeout',
  '--temperature',
  '--max-tokens',
  '--reasoning',
  '--shell',
]);

const BOOLEAN_FLAGS = new Set([
  '--emit-only',
  '--source',
  '--no-stream',
  '--json',
  '--quiet',
  '--verbose',
  '--log',
  '--force',
  '--reveal',
  '--help',
  '--version',
]);

const SHORT_FLAGS: Record<string, string> = {
  h: '--help',
  V: '--version',
  q: '--quiet',
  v: '--verbose',
  l: '--lang',
  o: '--out',
  d: '--out-dir',
  s: '--source',
};

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { command: null, positionals: [], options: {}, help: false, version: false };
  let index = 0;
  let endOfFlags = false;

  while (index < argv.length) {
    const arg = argv[index]!;

    if (endOfFlags) {
      parsed.positionals.push(arg);
      index += 1;
      continue;
    }

    if (arg === '--') {
      endOfFlags = true;
      index += 1;
      continue;
    }

    if (arg === '-' || !arg.startsWith('-')) {
      if (!parsed.command && COMMANDS.has(arg)) parsed.command = arg;
      else parsed.positionals.push(arg);
      index += 1;
      continue;
    }

    if (arg.startsWith('--')) {
      const equals = arg.indexOf('=');
      const name = equals >= 0 ? arg.slice(0, equals) : arg;
      const inlineValue = equals >= 0 ? arg.slice(equals + 1) : undefined;

      if (VALUED_FLAGS.has(name)) {
        const value = inlineValue ?? argv[index + 1];
        if (value === undefined) throw new UsageError(`option ${name} requires a value`);
        if (inlineValue === undefined) index += 1;
        applyValuedOption(parsed, name, value);
      } else if (BOOLEAN_FLAGS.has(name)) {
        if (inlineValue !== undefined) throw new UsageError(`option ${name} does not take a value`);
        applyBooleanOption(parsed, name);
      } else {
        throw new UsageError(`unknown option "${name}"`, { hint: `run "${PROGRAM} --help" for the option list` });
      }
      index += 1;
      continue;
    }

    const chars = arg.slice(1);
    if (chars.length > 1) {
      const asLong = `--${chars}`;
      if (BOOLEAN_FLAGS.has(asLong)) {
        applyBooleanOption(parsed, asLong);
        index += 1;
        continue;
      }
      if (VALUED_FLAGS.has(asLong)) {
        const value = argv[index + 1];
        if (value === undefined) throw new UsageError(`option ${asLong} requires a value`);
        applyValuedOption(parsed, asLong, value);
        index += 2;
        continue;
      }
    }
    for (const ch of chars) {
      const long = SHORT_FLAGS[ch];
      if (!long) {
        throw new UsageError(`unknown option "-${ch}"`, { hint: `run "${PROGRAM} --help" for the option list` });
      }
      if (VALUED_FLAGS.has(long)) {

        if (chars.length > 1) {
          throw new UsageError(`"-${ch}" cannot be bundled`, { hint: `use ${long} <value> instead` });
        }
        const value = argv[index + 1];
        if (value === undefined) throw new UsageError(`option ${long} requires a value`);
        applyValuedOption(parsed, long, value);
        index += 1;
      } else {
        applyBooleanOption(parsed, long);
      }
    }
    index += 1;
  }

  return parsed;
}

function applyBooleanOption(parsed: ParsedArgs, name: string): void {
  switch (name) {
    case '--emit-only':
      parsed.options.emitOnly = true;
      break;
    case '--source':
      parsed.options.sourceOnly = true;
      break;
    case '--no-stream':
      parsed.options.noStream = true;
      break;
    case '--json':
      parsed.options.json = true;
      break;
    case '--quiet':
      parsed.options.quiet = true;
      break;
    case '--verbose':
      parsed.options.verbose = true;
      break;
    case '--log':
      parsed.options.log = true;
      break;
    case '--force':
      parsed.options.force = true;
      break;
    case '--reveal':
      parsed.options.reveal = true;
      break;
    case '--help':
      parsed.help = true;
      break;
    case '--version':
      parsed.version = true;
      break;
    default:
      throw new UsageError(`unknown option "${name}"`);
  }
}

function applyValuedOption(parsed: ParsedArgs, name: string, value: string): void {
  switch (name) {
    case '--lang':
      parsed.options.lang = value;
      break;
    case '--out':
      parsed.options.outPath = value;
      break;
    case '--out-dir':
      parsed.options.outDir = value;
      break;
    case '--model':
      parsed.options.model = value;
      break;
    case '--base-url':
      parsed.options.baseUrl = value;
      break;
    case '--api-key':
      parsed.options.apiKey = value;
      break;
    case '--timeout':
      parsed.options.timeoutMs = parseNumber(name, value, { min: 500, integer: true });
      break;
    case '--temperature':
      parsed.options.temperature = parseNumber(name, value, { min: 0, max: 2 });
      break;
    case '--max-tokens':
      parsed.options.maxTokens = parseNumber(name, value, { min: 16, integer: true });
      break;
    case '--reasoning':
      parsed.options.reasoning = value;
      break;
    case '--shell':
      parsed.options.shell = value;
      break;
    default:
      throw new UsageError(`unknown option "${name}"`);
  }
}

function parseNumber(name: string, raw: string, bounds: { min?: number; max?: number; integer?: boolean }): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new UsageError(`option ${name} expects a number, got "${raw}"`);
  if (bounds.integer && !Number.isInteger(value)) throw new UsageError(`option ${name} expects an integer, got "${raw}"`);
  if (bounds.min !== undefined && value < bounds.min) throw new UsageError(`option ${name} must be >= ${bounds.min}`);
  if (bounds.max !== undefined && value > bounds.max) throw new UsageError(`option ${name} must be <= ${bounds.max}`);
  return value;
}

interface SourceInput {
  text: string;
  label: string;
}

async function main(argv: string[]): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    return reportError(err, new Ui());
  }

  if (parsed.version) {
    process.stdout.write(`${PROGRAM} ${VERSION}\n`);
    return EXIT.OK;
  }

  if (parsed.help) {
    printHelp(parsed.positionals[0]);
    return EXIT.OK;
  }

  const ui = new Ui({
    json: parsed.options.json === true,
    quiet: parsed.options.quiet === true,
    verbose: parsed.options.verbose === true,
    log: parsed.options.log === true || parsed.options.verbose === true,
  });

  try {
    if (parsed.command === 'help') {
      printHelp(parsed.positionals[0]);
      return EXIT.OK;
    }

    if (parsed.command === 'init') {
      return await runInit({
        baseUrl: parsed.options.baseUrl,
        apiKey: parsed.options.apiKey,
        model: parsed.options.model,
        temperature: parsed.options.temperature,
        maxTokens: parsed.options.maxTokens,
        reasoning: parsed.options.reasoning,
        force: parsed.options.force,
        json: parsed.options.json,
      });
    }

    if (parsed.command === 'config') return configCommand(parsed, ui);
    if (parsed.command === 'doctor') return await doctorCommand(parsed, ui);

    if (parsed.command === 'models') {
      if (parsed.positionals.length > 1) {
        throw new UsageError('models takes at most one selector', {
          hint: `${PROGRAM} models          list models\n${PROGRAM} models '#6'    select the sixth model`,
        });
      }
      return await runModelsCommand({
        selector: parsed.positionals[0],
        json: parsed.options.json,
        baseUrl: parsed.options.baseUrl,
        apiKey: parsed.options.apiKey,
        timeoutMs: parsed.options.timeoutMs,
      });
    }

    if (parsed.command === null && parsed.positionals[0] === 'eval') {
      throw new UsageError('the "eval" command was removed; shitc compiles files', {
        hint: `put the source in a file, then run: ${PROGRAM} hello.shit`,
      });
    }

    if (parsed.command === 'run') return await compileCommand(parsed, ui, 'run');
    if (parsed.command === null) return await compileCommand(parsed, ui, 'compile');

    throw new UsageError(`unknown command "${parsed.command}"`, { hint: `run "${PROGRAM} --help"` });
  } catch (err) {
    return reportError(err, ui);
  }
}

async function compileCommand(parsed: ParsedArgs, ui: Ui, mode: CompileMode): Promise<number> {
  if (parsed.options.outPath && parsed.options.outDir) {
    throw new UsageError('use either -o <path> or -d/--out-dir <dir>, not both', {
      hint: '-o names the executable for compiled targets; -d writes sources and artifacts into a directory',
    });
  }

  const input = await resolveInput(parsed);
  const controller = new AbortController();
  const onSigint = (): void => {
    process.stderr.write('\n');
    controller.abort();
  };
  process.on('SIGINT', onSigint);

  try {
    const result = await compile({
      source: input.text,
      sourceLabel: input.label,
      mode,
      lang: parsed.options.lang,
      emitOnly: parsed.options.emitOnly,
      sourceOnly: parsed.options.sourceOnly,
      outPath: parsed.options.outPath,
      outDir: parsed.options.outDir,
      noStream: parsed.options.noStream,
      shell: parsed.options.shell,
      model: parsed.options.model,
      baseUrl: parsed.options.baseUrl,
      apiKey: parsed.options.apiKey,
      timeoutMs: parsed.options.timeoutMs,
      temperature: parsed.options.temperature,
      maxTokens: parsed.options.maxTokens,
      signal: controller.signal,
      ui,
    });
    return renderResult(result, ui);
  } finally {
    process.off('SIGINT', onSigint);
  }
}

function renderResult(result: CompileResult, ui: Ui): number {
  if (ui.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.ok ? EXIT.OK : EXIT.COMPILE_FAILED;
  }

  if (result.ok) return EXIT.OK;

  const failure = result.error;
  ui.error(failure?.message ?? 'compilation failed');

  if (failure?.exitCode === 127) {
    process.stderr.write(
      `  ${color.dim('hint')}  command not found: the target toolchain is not installed. ` +
        `run "shitc doctor", pick an available language, or use -s to emit source only\n`,
    );
  }

  if (failure?.output) {

    ui.outputBlock(failure.output);
  }

  if (ui.logEnabled) ui.note(`output kept in ${result.outDir}`);

  return EXIT.COMPILE_FAILED;
}

async function resolveInput(parsed: ParsedArgs): Promise<SourceInput> {
  const positionals = parsed.positionals;

  if (positionals[0] === '-') return { text: await readStdin(), label: '<stdin>' };

  const file = positionals[0];
  if (!file) {
    if (!process.stdin.isTTY) return { text: await readStdin(), label: '<stdin>' };
    throw new UsageError('no input file', {
      hint: `${PROGRAM} hello.shit   ${symbol.bullet}   ${PROGRAM} examples/hello.shit`,
    });
  }

  if (positionals.length > 1) {
    throw new UsageError(`expected one input file, got ${positionals.length}`, {
      hint: 'concatenate the sources into one file; shitc compiles one program at a time',
    });
  }

  return readSourceFile(file);
}

function readSourceFile(file: string): SourceInput {
  const absolute = path.resolve(process.cwd(), file);
  let stats;
  try {
    stats = statSync(absolute);
  } catch (cause) {
    throw new InputError(`cannot read "${file}"`, {
      hint: `resolved to ${absolute}`,
      cause,
    });
  }

  if (stats.isDirectory()) {
    throw new InputError(`"${file}" is a directory`, { hint: 'pass a source file' });
  }
  if (stats.size > MAX_SOURCE_BYTES) {
    throw new InputError(`"${file}" is too large (${formatBytes(stats.size)})`, {
      hint: `keep ShitLang sources under ${formatBytes(MAX_SOURCE_BYTES)}`,
    });
  }

  let text: string;
  try {
    text = readFileSync(absolute, 'utf8');
  } catch (cause) {
    throw new InputError(`cannot read "${file}"`, { cause });
  }

  if (!text.trim()) throw new InputError(`"${file}" is empty`, { hint: 'nothing to compile' });

  return { text, label: file };
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new InputError('stdin is a terminal', { hint: 'pipe the source in, e.g. echo \'prit("hi")\' | shitc' });
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    total += buffer.length;
    if (total > MAX_SOURCE_BYTES) {
      throw new InputError('source on stdin is too large', { hint: `limit is ${formatBytes(MAX_SOURCE_BYTES)}` });
    }
    chunks.push(buffer);
  }

  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) throw new InputError('stdin is empty', { hint: 'nothing to compile' });
  return text;
}

function configCommand(parsed: ParsedArgs, ui: Ui): number {
  const [sub, ...rest] = parsed.positionals;
  const loaded = loadConfig();

  switch (sub) {
    case undefined:
    case 'list': {
      if (ui.json) {
        process.stdout.write(
          `${JSON.stringify(
            {
              path: loaded.path,
              dir: loaded.dir,
              exists: loaded.exists,
              values: { ...loaded.config, apiKey: maskSecret(loaded.config.apiKey) },
              sources: loaded.sources,
            },
            null,
            2,
          )}\n`,
        );
        return EXIT.OK;
      }
      process.stdout.write(`${color.dim('config')} ${loaded.path}${loaded.exists ? '' : color.dim(' (not created yet)')}\n`);
      const rows = describeConfig(loaded);
      const width = Math.max(...rows.map((row) => row.key.length));
      for (const row of rows) {
        process.stdout.write(`  ${row.key.padEnd(width)} = ${row.value} ${color.dim(`(${row.source})`)}\n`);
      }
      return EXIT.OK;
    }

    case 'path':
      process.stdout.write(`${configPath()}\n`);
      return EXIT.OK;

    case 'get': {
      const rawKey = rest[0];
      const key = rawKey ? normalizeKey(rawKey) : null;
      if (!key) {
        throw new UsageError(`unknown config key "${rawKey ?? ''}"`, {
          hint: 'known keys: baseUrl, apiKey, model, temperature, maxTokens, timeoutMs',
        });
      }
      const rawValue = loaded.config[key];
      const value = key === 'apiKey' && !parsed.options.reveal ? maskSecret(String(rawValue)) : String(rawValue);
      if (ui.json) {
        process.stdout.write(`${JSON.stringify({ key, value, source: loaded.sources[key] }, null, 2)}\n`);
      } else {
        process.stdout.write(`${value}\n`);
      }
      return EXIT.OK;
    }

    case 'set': {
      let rawKey = '';
      let rawValue = '';
      if (rest.length === 1 && rest[0]!.includes('=')) {
        const equals = rest[0]!.indexOf('=');
        rawKey = rest[0]!.slice(0, equals);
        rawValue = rest[0]!.slice(equals + 1);
      } else if (rest.length >= 2) {
        rawKey = rest[0]!;
        rawValue = rest.slice(1).join(' ');
      } else {
        throw new UsageError('usage: shitc config set <key> <value>', {
          hint: 'examples: shitc config set model gpt-4o-mini · shitc config set apiKey=sk-...',
        });
      }

      const assignment = parseConfigAssignment(rawKey, rawValue);
      const saved = saveConfig({ [assignment.key]: assignment.value } as Partial<ShitcConfig>);
      const display = assignment.key === 'apiKey' ? maskSecret(String(assignment.value)) : String(assignment.value);

      if (ui.json) {
        process.stdout.write(`${JSON.stringify({ ok: true, path: saved.path, key: assignment.key, value: display }, null, 2)}\n`);
      } else {
        process.stdout.write(`${color.green(symbol.ok)} ${assignment.key} = ${display} ${color.dim(`(${saved.path})`)}\n`);
      }
      return EXIT.OK;
    }

    default:
      throw new UsageError(`unknown config subcommand "${sub}"`, {
        hint: 'usage: shitc config [list|get <key>|set <key> <value>|path]',
      });
  }
}

interface DoctorCheck {
  label: string;
  ok: boolean;
  detail: string;
  fatal: boolean;
}

async function doctorCommand(parsed: ParsedArgs, ui: Ui): Promise<number> {
  const loaded = loadConfig();
  const shell = detectShell(parsed.options.shell);
  const toolchains = detectToolchains();
  const issues = inspectConfig(loaded.config);
  const checks: DoctorCheck[] = [];

  checks.push({
    label: 'config file',
    ok: true,
    detail: loaded.exists ? loaded.path : `${loaded.path} (missing; using defaults)`,
    fatal: false,
  });
  checks.push({
    label: 'endpoint',
    ok: !issues.some((issue) => issue.field === 'baseUrl'),
    detail: `${loaded.config.baseUrl} ${color.dim(`(${loaded.sources.baseUrl})`)}`,
    fatal: true,
  });
  checks.push({
    label: 'model',
    ok: !issues.some((issue) => issue.field === 'model'),
    detail: `${loaded.config.model} ${color.dim(`(${loaded.sources.model})`)}`,
    fatal: true,
  });

  const keyIssue = issues.find((issue) => issue.field === 'apiKeyMissing');
  checks.push({
    label: 'api key',
    ok: !keyIssue,
    detail: loaded.config.apiKey
      ? `${maskSecret(loaded.config.apiKey)} ${color.dim(`(${loaded.sources.apiKey})`)}`
      : isLoopbackUrl(loaded.config.baseUrl)
        ? color.dim('not required for loopback endpoints')
        : color.red('missing — run "shitc init"'),
    fatal: true,
  });
  checks.push({
    label: 'shell',
    ok: shell.found,
    detail: `${shell.display} ${color.dim(`${symbol.bullet} ${shellExecForm(shell)}`)}`,
    fatal: false,
  });
  const outSource = process.env.SHITC_OUT_DIR
    ? 'SHITC_OUT_DIR'
    : process.env.SHITC_ARTIFACT_DIR
      ? 'SHITC_ARTIFACT_DIR'
      : 'default: build cache';
  checks.push({
    label: 'output',
    ok: true,
    detail: `${outputRoot()} ${color.dim(`(${outSource}; -o overrides)`)}`,
    fatal: false,
  });
  checks.push({
    label: 'toolchains',
    ok: toolchains.length > 0,
    detail: toolchains.length > 0 ? formatToolchains(toolchains) : color.yellow('none detected on PATH'),
    fatal: false,
  });
  checks.push({
    label: 'timeout',
    ok: true,
    detail: `${loaded.config.timeoutMs}ms ${color.dim(`${symbol.bullet} temperature=${loaded.config.temperature} ${symbol.bullet} maxTokens=${loaded.config.maxTokens}`)}`,
    fatal: false,
  });
  checks.push({
    label: 'reasoning',
    ok: true,
    detail: loaded.config.reasoningParam
      ? `${loaded.config.reasoningParam} = ${loaded.config.reasoningValue}`
      : color.dim('disabled'),
    fatal: false,
  });

  const connectivity = keyIssue || issues.some((issue) => issue.field === 'baseUrl')
    ? { ok: false, skipped: true, detail: 'skipped (fix configuration first)' }
    : await checkConnectivity(loaded.config);

  const fatalFailures = [
    ...checks.filter((check) => check.fatal && !check.ok),
    ...(connectivity.skipped || connectivity.ok ? [] : [{ fatal: true }]),
  ];

  if (ui.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: fatalFailures.length === 0,
          configPath: loaded.path,
          configExists: loaded.exists,
          configDir: configDir(),
          values: { ...loaded.config, apiKey: maskSecret(loaded.config.apiKey) },
          sources: loaded.sources,
          shell: { name: shell.name, kind: shell.kind, path: shell.path, display: shell.display, found: shell.found },
          toolchains: toolchains.map((tool) => tool.command),
          checks: checks.map((check) => ({ label: check.label, ok: check.ok, detail: check.detail })),
          connectivity,
          issues: issues.map((issue) => ({ field: issue.field, message: issue.message, hint: issue.hint })),
        },
        (_key, value: unknown) => (typeof value === 'string' ? stripAnsi(value) : value),
        2,
      )}\n`,
    );
    return fatalFailures.length === 0 ? EXIT.OK : 1;
  }

  process.stdout.write(`${color.bold(`${PROGRAM} ${VERSION}`)} ${color.dim(`${TAGLINE} ${symbol.bullet} doctor`)}\n\n`);
  for (const check of checks) {
    const glyph = check.ok ? color.green(symbol.ok) : check.fatal ? color.red(symbol.fail) : color.yellow(symbol.warn);
    process.stdout.write(`  ${glyph} ${check.label.padEnd(12)} ${check.detail}\n`);
  }

  const connectivityGlyph = connectivity.skipped
    ? color.yellow(symbol.warn)
    : connectivity.ok
      ? color.green(symbol.ok)
      : color.red(symbol.fail);
  process.stdout.write(`  ${connectivityGlyph} ${'connectivity'.padEnd(12)} ${connectivity.detail}\n`);

  for (const issue of issues) {
    process.stdout.write(`\n  ${color.yellow(symbol.warn)} ${issue.message}\n    ${color.dim(`hint: ${issue.hint}`)}\n`);
  }

  const ready = fatalFailures.length === 0;
  process.stdout.write(
    `\n  ${ready ? color.green(symbol.ok) : color.red(symbol.fail)} ${ready ? 'ready to compile' : 'fix the failures above'}\n`,
  );
  if (!ready || (!loaded.exists && loaded.sources.apiKey === 'default')) {
    process.stdout.write(`  ${color.dim(`hint: ${PROGRAM} init`)} ${color.dim('writes ~/.shitc/config.json')}\n`);
  }

  return ready ? EXIT.OK : 1;
}

interface ConnectivityResult {
  ok: boolean;
  skipped: boolean;
  detail: string;
}

async function checkConnectivity(config: ShitcConfig): Promise<ConnectivityResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  timer.unref?.();
  const startedAt = Date.now();

  try {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
    const response = await fetch(`${config.baseUrl}/models`, { headers, signal: controller.signal });
    const elapsed = formatDuration(Date.now() - startedAt);

    if (response.status === 401 || response.status === 403) {
      return { ok: false, skipped: false, detail: `GET /models → HTTP ${response.status} ${color.dim(`(${elapsed})`)} · api key rejected` };
    }
    if (!response.ok) {

      const soft = response.status === 404 || response.status === 405;
      return {
        ok: soft,
        skipped: false,
        detail: `GET /models → HTTP ${response.status} ${color.dim(`(${elapsed})`)}${soft ? ' · endpoint reachable (no /models route)' : ''}`,
      };
    }

    let models: string[] = [];
    try {
      const body: unknown = await response.json();
      if (isRecord(body) && Array.isArray(body.data)) {
        models = body.data
          .map((entry) => (isRecord(entry) ? entry.id : undefined))
          .filter((id): id is string => typeof id === 'string');
      }
    } catch {

    }

    const listed = models.includes(config.model);
    const modelNote = models.length === 0 ? '' : listed ? ` · "${config.model}" listed` : ` · "${config.model}" not listed`;
    return { ok: true, skipped: false, detail: `GET /models → HTTP 200 ${color.dim(`(${elapsed})`)} · ${models.length} models${modelNote}` };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, skipped: false, detail: `cannot reach ${hostOf(config.baseUrl)}: ${oneLine(message, 160)}` };
  } finally {
    clearTimeout(timer);
  }
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

function reportError(err: unknown, ui: Ui): number {
  const exitCode = err instanceof ShitcError ? err.exitCode : EXIT.ICE;

  if (err instanceof SourceError) {
    if (ui.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            ok: false,
            error: {
              kind: 'syntax',
              code: null,
              message: err.message,
              diagnostics: err.diagnostics.map((diagnostic) => ({
                line: diagnostic.line,
                message: diagnostic.message,
                hint: diagnostic.hint ?? null,
              })),
              hint: err.hint ?? null,
            },
          },
          null,
          2,
        )}\n`,
      );
      return EXIT.COMPILE_FAILED;
    }

    for (const diagnostic of err.diagnostics) {
      process.stderr.write(
        `${err.sourceLabel}:${diagnostic.line}: ${color.red('error')}: ${diagnostic.message}\n`,
      );
      if (diagnostic.hint) process.stderr.write(`  ${color.dim(`hint: ${diagnostic.hint}`)}\n`);
    }
    const count = err.diagnostics.length;
    process.stderr.write(`${color.dim(`${count} error${count === 1 ? '' : 's'} generated.`)}\n`);
    return EXIT.COMPILE_FAILED;
  }

  if (ui.json) {
    const payload = {
      ok: false,
      error: {
        kind:
          err instanceof InternalCompilerError
            ? 'ice'
            : err instanceof UsageError
              ? 'usage'
              : err instanceof InputError
                ? 'input'
                : err instanceof InterruptedError
                  ? 'interrupted'
                  : 'internal',
        code: err instanceof InternalCompilerError ? err.code : null,
        message: err instanceof Error ? err.message : String(err),
        hint: err instanceof ShitcError ? (err.hint ?? null) : null,
        detail: err instanceof InternalCompilerError ? (err.detail ?? null) : null,
      },
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return exitCode;
  }

  if (err instanceof InterruptedError) {
    process.stderr.write(`${color.yellow(symbol.warn)} interrupted\n`);
    return EXIT.INTERRUPTED;
  }

  if (err instanceof InternalCompilerError) {
    process.stderr.write(`${color.red(`${symbol.fail} ${err.message}`)}\n`);
    process.stderr.write(`  ${color.dim('code')}    ${err.code} ${symbol.bullet} ${ICE_TITLES[err.code]}\n`);
    if (err.hint) process.stderr.write(`  ${color.dim('hint')}    ${err.hint}\n`);
    if (err.detail) {
      for (const line of err.detail.split(/\r?\n/)) process.stderr.write(`  ${color.dim('detail')}  ${line}\n`);
    }
    if (ui.verbose && err.stack) process.stderr.write(`${color.dim(err.stack)}\n`);
    return exitCode;
  }

  if (err instanceof UsageError || err instanceof InputError) {
    process.stderr.write(`${color.red(`${symbol.fail} ${err.message}`)}\n`);
    if (err.hint) process.stderr.write(`  ${color.dim('hint')}  ${err.hint}\n`);
    return exitCode;
  }

  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${color.red(`${symbol.fail} unexpected internal error: ${message}`)}\n`);
  process.stderr.write(`  ${color.dim('code')}  ICE-011 ${symbol.bullet} ${ICE_TITLES['ICE-011']}\n`);
  process.stderr.write(`  ${color.dim('hint')}  re-run with --verbose and report this\n`);
  if (ui.verbose && err instanceof Error && err.stack) process.stderr.write(`${color.dim(err.stack)}\n`);
  return EXIT.ICE;
}

function printHelp(topic?: string): void {
  const out = process.stdout;
  const b = color.bold;
  const d = color.dim;

  if (topic && !['usage', 'config', 'init', 'doctor', 'examples'].includes(topic)) {
    out.write(`${color.yellow(symbol.warn)} no help topic "${topic}"; showing the full reference\n\n`);
  }

  out.write(`${b(`${PROGRAM} ${VERSION}`)} ${d(`— ${TAGLINE}`)}\n\n`);

  const usage: Array<[string, string]> = [
    [`${PROGRAM} <file.shit>`, 'compile a ShitLang file'],
    [`${PROGRAM} run <file.shit>`, 'compile and run a ShitLang file'],
    [`${PROGRAM} -`, 'compile source piped on stdin'],
    [`${PROGRAM} models [#n|name]`, 'list endpoint models; #n selects and saves one'],
    [`${PROGRAM} init`, 'configure the model endpoint (~/.shitc)'],
    [`${PROGRAM} config [list|get|set|path]`, 'inspect or edit configuration'],
    [`${PROGRAM} doctor`, 'check config, shell, toolchains, connectivity'],
  ];
  const usageWidth = Math.max(...usage.map(([line]) => line.length));
  out.write(`Usage\n`);
  for (const [line, description] of usage) out.write(`  ${b(line.padEnd(usageWidth))}  ${d(description)}\n`);
  out.write('\n');

  out.write(`Options\n`);
  const options: Array<[string, string]> = [
    ['-l, --lang <language>', 'force the target language (default: the model chooses)'],
    ['--emit-only', 'generate and print the code without building or running it'],
    ['-s, --source', 'write generated source files only (no build, no run)'],
    ['-o, --out <path>', 'output file: executable (compiled) or entry source (interpreted)'],
    ['-d, --out-dir <dir>', 'write sources and build artifacts into <dir>'],
    ['--log', 'print compiler phases, plan and build/run commands'],
    ['--shell <shell>', 'shell used to run commands (default: auto-detect)'],
    ['--no-stream', 'disable SSE streaming from the model'],
    ['--model <name>', 'override the configured model'],
    ['--base-url <url>', 'override the OpenAI-compatible base URL'],
    ['--api-key <key>', 'override the configured API key'],
    ['--timeout <ms>', 'override the request timeout'],
    ['--temperature <n>', 'override sampling temperature (0-2)'],
    ['--max-tokens <n>', 'override max output tokens'],
    ['--reasoning <param=value>', 'CoT/reasoning parameter for init (e.g. reasoning_effort=high)'],
    ['--json', 'machine-readable result on stdout'],
    ['-q, --quiet', 'suppress progress output'],
    ['-v, --verbose', 'trace model requests, retries and fallbacks'],
    ['-h, --help', 'show this help'],
    ['-V, --version', 'show the version'],
  ];
  const optionWidth = Math.max(...options.map(([flag]) => flag.length));
  for (const [flag, description] of options) out.write(`  ${flag.padEnd(optionWidth)}  ${description}\n`);
  out.write('\n');

  out.write(`Examples\n`);
  const examples: Array<[string, string]> = [
    [`${PROGRAM} examples/hello.shit`, 'compile'],
    [`${PROGRAM} run examples/hello.shit`, 'compile and run'],
    [`${PROGRAM} -o ./main.py examples/hello.shit`, 'interpreted: entry source at ./main.py'],
    [`${PROGRAM} -o ./main --lang c examples/main.c`, 'compiled: executable at ./main'],
    [`${PROGRAM} -d build examples/hello.shit`, 'directory: sources and artifacts in ./build'],
    [`${PROGRAM} --emit-only examples/hello.shit`, 'generate only'],
    [`${PROGRAM} -s -o ./main.cbl --lang cobol examples/hello.shit`, 'source file only (no compiler needed)'],
    [`${PROGRAM} --lang python examples/sum-1-to-100.shit`, 'force the target language'],
    [`${PROGRAM} --log run examples/hello.shit`, 'show compiler phases'],
    [`${PROGRAM} models`, 'list models from the endpoint'],
    [`${PROGRAM} models '#6'`, 'use the 6th model'],
    [`${PROGRAM} doctor --json`, 'machine-readable health check'],
  ];
  const exampleWidth = Math.max(...examples.map(([command]) => command.length));
  for (const [command, comment] of examples) out.write(`  ${d('$')} ${command.padEnd(exampleWidth)}  ${d(`# ${comment}`)}\n`);
  out.write('\n');
  out.write(`  Make a file executable with a shebang:\n`);
  out.write(`  ${d('$')} printf '#!/usr/bin/env ${PROGRAM}\\nprit("helloword")\\n' > hello.shit\n`);
  out.write(`  ${d('$')} chmod +x hello.shit && ./hello.shit\n\n`);

  out.write(`How it works\n`);
  out.write(`  shitc reads a source file, detects your shell and the toolchains on PATH, requests a\n`);
  out.write(`  program from an OpenAI-protocol model, writes the generated files to\n`);
  out.write(`  ~/.shitc/build/<id>/ and builds them. Compiled targets keep only sources in the\n`);
  out.write(`  cache; the executable is placed in the current directory (or at the -o path).\n`);
  out.write(`  "run" also executes it. Use -d <dir> to keep sources and artifacts in one directory.\n\n`);

  out.write(`Configuration ${d('(~/.shitc/config.json, mode 0600)')}\n`);
  const configRows: Array<[string, string]> = [
    ['baseUrl', 'OpenAI-compatible endpoint, usually ending in /v1'],
    ['apiKey', 'bearer token (not needed for loopback endpoints)'],
    ['model', 'model name, e.g. gpt-4o-mini or deepseek-chat'],
    ['temperature', 'sampling temperature (default 0)'],
    ['maxTokens', 'max output tokens (default 4096)'],
    ['timeoutMs', 'request timeout in ms (default 120000)'],
    ['reasoningParam', 'CoT request field, e.g. reasoning_effort (empty = disabled)'],
    ['reasoningValue', 'value for reasoningParam, e.g. low/medium/high/max or true'],
  ];
  const configWidth = Math.max(...configRows.map(([key]) => key.length));
  for (const [key, description] of configRows) out.write(`  ${b(key.padEnd(configWidth))}  ${description}\n`);
  out.write('\n');
  out.write(`  Environment overrides: SHITC_BASE_URL, SHITC_API_KEY, OPENAI_API_KEY, SHITC_MODEL,\n`);
  out.write(`  SHITC_CONFIG_DIR, SHITC_OUT_DIR, SHITC_SHELL, SHITC_NO_STREAM,\n`);
  out.write(`  SHITC_REASONING (param=value), SHITC_REASONING_PARAM, SHITC_REASONING_VALUE\n\n`);

  out.write(`Exit codes\n`);
  out.write(`  ${b('0')} success   ${b('64')} usage   ${b('65')} compile/run failed   ${b('66')} bad input\n`);
  out.write(`  ${b('65')} also covers ShitLang syntax errors (e.g. a request instead of code)\n`);
  out.write(`  ${b('70')} internal compiler error (ICE)   ${b('130')} interrupted\n`);
}

void main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(`${color.red(`${symbol.fail} fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`)}\n`);
    process.exitCode = EXIT.ICE;
  });
