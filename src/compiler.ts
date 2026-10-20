import { statSync } from 'node:fs';
import path from 'node:path';
import { assertConfigured, loadConfig, type ShitcConfig } from './config.js';
import { ICE, InternalCompilerError, InterruptedError, SourceError, UsageError } from './errors.js';
import {
  exportArtifact,
  exportArtifactFile,
  findRunArtifact,
  removeBuiltArtifact,
  resolveOutputDir,
  runStage,
  writeArtifacts,
  type StageResult,
  type WrittenFile,
} from './executor.js';
import { chat, type ChatResult, type Usage } from './llm.js';
import { parsePlanDetailed } from './parser.js';
import { buildSystemPrompt, buildUserPrompt } from './prompt.js';
import type { ProgramPlan } from './schema.js';
import { detectShell } from './shell.js';
import { detectToolchains } from './toolchains.js';
import { Ui } from './ui.js';
import { estimateTokens, expandHome, formatBytes, formatDuration, oneLine } from './util.js';
import { PROGRAM, VERSION } from './version.js';

export type CompileMode = 'compile' | 'run';

export interface CompileRequest {
  source: string;
  sourceLabel: string;
  mode?: CompileMode;

  lang?: string;
  emitOnly?: boolean;

  sourceOnly?: boolean;

  outPath?: string;

  outDir?: string;
  noStream?: boolean;
  shell?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  ui?: Ui;
}

export interface CompileFailure {
  stage: 'compile' | 'run';
  exitCode: number | null;
  timedOut: boolean;
  message: string;

  output: string;
}

export interface CompileResult {
  ok: boolean;
  mode: CompileMode;

  ran: boolean;
  compiler: { name: string; version: string };
  durationMs: number;
  source: { label: string; bytes: number; lines: number };
  shell: { name: string; kind: string; path: string; display: string };
  config: { baseUrl: string; model: string };
  plan: ProgramPlan;
  outDir: string;
  written: WrittenFile[];
  stages: StageResult[];
  usage: Usage | null;
  model: string;
  emittedOnly: boolean;
  sourceOnly: boolean;
  error: CompileFailure | null;
}

const COMPILE_TIMEOUT_DEFAULT_MS = 180_000;
const RUN_TIMEOUT_DEFAULT_MS = 60_000;

export async function compile(request: CompileRequest): Promise<CompileResult> {
  const startedAt = Date.now();
  const mode: CompileMode = request.mode ?? 'compile';
  const ui = request.ui ?? new Ui();
  const source = normalizeSource(request.source);

  ui.log('start', `${PROGRAM} ${VERSION} · ${request.sourceLabel} · ${source.lines} line(s), ${formatBytes(source.bytes)} · mode=${mode}`);

  const loaded = loadConfig();
  const config = withOverrides(loaded.config, request);
  assertConfigured(config);
  throwIfAborted(request.signal);
  ui.log('config', `config=${loaded.path} exists=${loaded.exists} baseUrl=${config.baseUrl} model=${config.model}`);

  const shell = detectShell(request.shell);
  const toolchains = detectToolchains();
  ui.log('shell', `${shell.display} path=${shell.path} found=${shell.found}`);
  ui.log('toolchains', `${toolchains.length} found: ${toolchains.map((tool) => tool.command).join(', ') || '(none)'}`);

  ui.banner([
    `${PROGRAM} ${VERSION} · ${shell.display} · ${process.platform} ${process.arch}`,
    `source  ${request.sourceLabel} (${source.lines} line${source.lines === 1 ? '' : 's'}, ${formatBytes(source.bytes)})`,
  ]);

  for (const warning of loaded.warnings) ui.verboseLog(`config: ${warning}`);
  if (!shell.found) {
    ui.warn(`shell "${shell.name}" was not found on PATH; commands may fail (use --shell to override)`);
  }

  const promptContext = { shell, toolchains, targetLanguage: request.lang };
  const systemPrompt = buildSystemPrompt(promptContext);
  const userPrompt = buildUserPrompt(source.text, promptContext);
  ui.log('prompt', `system=${formatBytes(Buffer.byteLength(systemPrompt))} user=${formatBytes(Buffer.byteLength(userPrompt))}`);
  const messages = [
    { role: 'system' as const, content: systemPrompt },
    { role: 'user' as const, content: userPrompt },
  ];

  const step = ui.step(`lowering shitlang ${request.lang ? `→ ${request.lang}` : '→ auto'}`);
  ui.log('request', `POST ${config.baseUrl}/chat/completions model=${config.model} stream=${request.noStream !== true && process.env.SHITC_NO_STREAM !== '1'}`);

  let completion: ChatResult;
  try {
    completion = await chat(config, messages, {
      stream: request.noStream !== true && process.env.SHITC_NO_STREAM !== '1',
      signal: request.signal,
      temperature: request.temperature,
      maxTokens: request.maxTokens,
      onDelta: (_delta, totalChars) => step.update(`${estimateTokens(totalChars)} tok`),
      debug: (message, detail) => ui.verboseLog(`llm ${message}`, detail),
    });
  } catch (cause) {
    step.fail('model call failed');
    ui.log('error', cause instanceof Error ? cause.message : String(cause));
    throw cause;
  }

  const usageNote = completion.usage ? ` ${completion.usage.promptTokens}+${completion.usage.completionTokens} tok` : '';
  ui.log(
    'response',
    `${formatDuration(completion.durationMs)}${usageNote} attempts=${completion.attempts}${completion.degraded.length > 0 ? ` degraded=${completion.degraded.join('|')}` : ''}`,
  );

  let plan: ProgramPlan;
  try {
    plan = parsePlanDetailed(completion.content).plan;
  } catch (cause) {
    if (cause instanceof SourceError) {
      step.fail('syntax error');
      ui.log('diagnostic', cause.diagnostics.map((diagnostic) => `${cause.sourceLabel}:${diagnostic.line}: ${diagnostic.message}`).join(' | '));
      throw new SourceError(request.sourceLabel, cause.diagnostics);
    }
    step.fail('model output rejected as ShitLang IR');
    ui.log('error', cause instanceof Error ? cause.message : String(cause));
    throw cause;
  }

  throwIfAborted(request.signal);

  const tokenNote = completion.usage ? ` · ${completion.usage.totalTokens} tok` : '';
  step.done(`${plan.language} · ${plan.runtimeKind}${tokenNote}`);
  ui.log('ir', `language=${plan.language} runtimeKind=${plan.runtimeKind} entry=${plan.entry} files=${plan.files.map((file) => file.path).join(',')}`);

  const outPathRaw = request.outPath?.trim();
  const sourceOnly = request.sourceOnly === true;
  const compiledTarget = Boolean(plan.compileCommand);

  const outPathWantsDir = Boolean(outPathRaw && (/[\\/]$/.test(outPathRaw) || outPathRaw === '.' || outPathRaw === '..'));
  const pathIsFile = Boolean(outPathRaw && !outPathWantsDir);
  const pathIsOutputDir = Boolean(outPathRaw && outPathWantsDir);

  if (pathIsFile && outPathRaw && isExistingDirectory(outPathRaw)) {
    throw new UsageError(`${outPathRaw} is a directory; -o names an output file`, {
      hint: `remove it, or use -d ${outPathRaw} for directory mode`,
    });
  }

  const outDir = resolveOutputDir(pathIsOutputDir ? outPathRaw : request.outDir);
  const written = writeArtifacts(outDir, plan.files);
  ui.log('write', `${written.length} file(s) → ${outDir}`);
  for (const file of written) ui.log('write', `${file.path} (${formatBytes(file.bytes)})`);

  const entryFileTarget =
    pathIsFile && (sourceOnly || !compiledTarget) && outPathRaw ? path.resolve(expandHome(outPathRaw)) : null;
  if (entryFileTarget) {
    try {
      const exported = exportArtifactFile(outDir, plan.entry, entryFileTarget);
      ui.log('export', `${plan.entry} → ${exported}`);
    } catch (cause) {
      throw new InternalCompilerError(ICE.WRITE, `cannot write ${entryFileTarget}`, {
        hint: 'check permissions',
        cause,
      });
    }
  }

  ui.detail('out', outDir);
  ui.detail('files', written.map((file) => `${file.path} (${formatBytes(file.bytes)})`).join(', '));
  if (plan.compileCommand) ui.detail('build', plan.compileCommand);
  ui.detail('run', plan.runCommand);
  if (plan.notes) ui.note(`  ${oneLine(plan.notes, 200)}`);

  const baseResult: CompileResult = {
    ok: true,
    mode,
    ran: false,
    compiler: { name: PROGRAM, version: VERSION },
    durationMs: 0,
    source: { label: request.sourceLabel, bytes: source.bytes, lines: source.lines },
    shell: { name: shell.name, kind: shell.kind, path: shell.path, display: shell.display },
    config: { baseUrl: config.baseUrl, model: config.model },
    plan,
    outDir,
    written,
    stages: [],
    usage: completion.usage,
    model: completion.model,
    emittedOnly: request.emitOnly === true,
    sourceOnly,
    error: null,
  };

  if (request.emitOnly || sourceOnly) {
    if (request.emitOnly) {
      for (const file of plan.files) ui.fileBlock(file.path, file.content);
      ui.status('emitted only (--emit-only): nothing was compiled or executed');
      ui.log('done', 'exit=0 (emit only)');
    } else {
      ui.log('done', 'exit=0 (source only)');
    }
    return { ...baseResult, durationMs: Date.now() - startedAt };
  }

  const live = !ui.json;

  if (plan.compileCommand) {
    ui.stageCommand(plan.compileCommand);
    ui.log('build', plan.compileCommand);
    const stage = await runStage({
      name: 'compile',
      command: plan.compileCommand,
      cwd: outDir,
      shell,
      timeoutMs: timeoutFromEnv('SHITC_COMPILE_TIMEOUT_MS', COMPILE_TIMEOUT_DEFAULT_MS),
      live,
      signal: request.signal,
    });
    baseResult.stages.push(stage);
    throwIfAborted(request.signal);

    ui.stageResult('compile', stage.succeeded, stage.exitCode, stage.durationMs, stage.timedOut);
    ui.log(
      'build',
      `${stage.succeeded ? 'ok' : stage.timedOut ? 'timeout' : `exit=${stage.exitCode}`} ${formatDuration(stage.durationMs)}`,
    );
    if (!stage.succeeded) {
      ui.log('done', 'exit=65 (build failed)');
      return {
        ...baseResult,
        ok: false,
        error: failureFrom(stage, live),
        durationMs: Date.now() - startedAt,
      };
    }
  }

  const explicitDir = Boolean(
    request.outDir?.trim() ||
      pathIsOutputDir ||
      process.env.SHITC_OUT_DIR?.trim() ||
      process.env.SHITC_ARTIFACT_DIR?.trim(),
  );
  const targetFile = pathIsFile && compiledTarget && !sourceOnly && outPathRaw ? path.resolve(expandHome(outPathRaw)) : null;
  let exportedArtifact: string | null = null;
  if (plan.compileCommand && (targetFile || !explicitDir)) {
    const artifact = findRunArtifact(outDir, plan.runCommand);
    if (artifact) {
      try {
        const exported = targetFile
          ? exportArtifactFile(outDir, artifact, targetFile)
          : exportArtifact(outDir, artifact, process.cwd());
        exportedArtifact = artifact;
        ui.log('export', `${artifact} → ${exported}`);
      } catch (cause) {
        ui.warn(
          `could not move ${artifact} to ${targetFile ?? 'the current directory'}: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    } else if (targetFile) {
      ui.warn(`could not determine the built executable from runCommand "${plan.runCommand}"; nothing written to ${targetFile}`);
    }
  }

  if (mode === 'compile') {
    if (exportedArtifact) removeBuiltArtifact(outDir, exportedArtifact);
    const howToRun = request.sourceLabel === '<stdin>' ? `${PROGRAM} run - < <file>` : `${PROGRAM} run ${request.sourceLabel}`;
    ui.note(`compiled only — not executed (run it with: ${howToRun})`);
    ui.log('done', 'exit=0 (compile only)');
    return { ...baseResult, durationMs: Date.now() - startedAt };
  }

  ui.stageCommand(plan.runCommand);
  ui.log('run', plan.runCommand);
  const run = await runStage({
    name: 'run',
    command: plan.runCommand,
    cwd: outDir,
    shell,
    timeoutMs: timeoutFromEnv('SHITC_RUN_TIMEOUT_MS', RUN_TIMEOUT_DEFAULT_MS),
    live,
    signal: request.signal,
  });
  baseResult.stages.push(run);
  throwIfAborted(request.signal);

  ui.stageResult('run', run.succeeded, run.exitCode, run.durationMs, run.timedOut);
  ui.log(
    'run',
    `${run.succeeded ? 'ok' : run.timedOut ? 'timeout' : `exit=${run.exitCode}`} ${formatDuration(run.durationMs)}`,
  );
  ui.log('done', `exit=${run.succeeded ? 0 : 65}`);

  if (exportedArtifact) removeBuiltArtifact(outDir, exportedArtifact);

  return {
    ...baseResult,
    ok: run.succeeded,
    ran: true,
    error: run.succeeded ? null : failureFrom(run, live),
    durationMs: Date.now() - startedAt,
  };
}

function failureFrom(stage: StageResult, live: boolean): CompileFailure {
  const label = stage.name === 'compile' ? 'build' : 'run';
  const message = stage.timedOut
    ? `${label} timed out`
    : stage.exitCode === null
      ? `${label} did not start (signal ${stage.signal ?? 'unknown'})`
      : `${label} failed (exit code ${stage.exitCode})`;

  const combined = [stage.stdout, stage.stderr].filter((part) => part.trim()).join('\n').trim();
  return {
    stage: stage.name,
    exitCode: stage.exitCode,
    timedOut: stage.timedOut,
    message,

    output: live ? '' : combined,
  };
}

interface NormalizedSource {
  text: string;
  bytes: number;
  lines: number;
}

function normalizeSource(raw: string): NormalizedSource {
  let text = raw ?? '';
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  text = text.replace(/^#![^\n]*\r?\n?/, '');
  text = text.replace(/\r\n?/g, '\n').trim();

  if (!text) {
    throw new InternalCompilerError(ICE.IR, 'source program is empty', {
      hint: 'pass a file, or pipe one on stdin',
    });
  }

  return { text, bytes: Buffer.byteLength(text, 'utf8'), lines: text.split('\n').length };
}

function isExistingDirectory(value: string): boolean {
  try {
    return statSync(path.resolve(expandHome(value))).isDirectory();
  } catch {
    return false;
  }
}

function withOverrides(config: ShitcConfig, request: CompileRequest): ShitcConfig {
  return {
    ...config,
    baseUrl: request.baseUrl?.trim() || config.baseUrl,
    apiKey: request.apiKey !== undefined ? request.apiKey.trim() : config.apiKey,
    model: request.model?.trim() || config.model,
    timeoutMs: request.timeoutMs ?? config.timeoutMs,
    temperature: request.temperature ?? config.temperature,
    maxTokens: request.maxTokens ?? config.maxTokens,
  };
}

function timeoutFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 500 ? value : fallback;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new InterruptedError('compile cancelled');
}
