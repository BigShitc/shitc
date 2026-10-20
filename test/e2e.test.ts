import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { hasCommand } from '../src/which.js';
import {
  PROJECT_ROOT,
  jsonReply,
  makeTempDir,
  planFor,
  removeDir,
  runCli,
  sseReply,
  startMockServer,
  type MockReply,
  type MockServer,
} from './helpers.js';

let tempRoot = '';
let caseCounter = 0;

before(() => {
  tempRoot = makeTempDir('shitc-e2e-');
});

after(() => {
  removeDir(tempRoot);
});

interface CaseEnv {
  env: Record<string, string>;
  outDir: string;
  configDir: string;
}

function caseEnv(mock: MockServer, extra: Record<string, string> = {}): CaseEnv {
  const id = (caseCounter += 1);
  const outDir = path.join(tempRoot, 'out', `case-${id}`);
  const configDir = path.join(tempRoot, 'config', `case-${id}`);
  return {
    outDir,
    configDir,
    env: {
      SHITC_CONFIG_DIR: configDir,
      SHITC_OUT_DIR: outDir,
      SHITC_BASE_URL: `${mock.url}/v1`,
      SHITC_API_KEY: 'test-key',
      SHITC_MODEL: 'mock-model',
      SHITC_SHELL: process.platform === 'win32' ? 'cmd' : 'bash',
      ...extra,
    },
  };
}

let sourceCounter = 0;

function sourceFile(content: string, name?: string): string {
  const dir = path.join(tempRoot, 'sources');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name ?? `source-${(sourceCounter += 1)}.shit`);
  writeFileSync(file, content);
  return file;
}

async function withServer(
  handler: () => MockReply | void | Promise<MockReply | void>,
  fn: (mock: MockServer) => Promise<void>,
): Promise<void> {
  const mock = await startMockServer(handler);
  try {
    await fn(mock);
  } finally {
    await mock.close();
  }
}

const REJECTED_PLAN = {
  status: 'invalid',
  diagnostics: [{ line: 1, message: 'expected a ShitLang program, found a request to write code' }],
  language: 'unknown',
  runtimeKind: 'interpreted',
  compileCommand: '',
  runCommand: '',
  files: [],
  entry: '',
  notes: '这不是一个程序，而是让我写代码的请求。',
};

const C_PLAN = {
  status: 'ok',
  diagnostics: [],
  language: 'c',
  runtimeKind: 'compiled',
  compileCommand: 'gcc main.c -o main',
  runCommand: './main',
  files: [{ path: 'main.c', content: '#include <stdio.h>\nint main(void) { puts("c ok"); return 0; }\n' }],
  entry: 'main.c',
  notes: 'c target',
};

describe('shitc end-to-end', () => {
  it('compiles a file without running it by default', async () => {
    const plan = planFor({
      files: [{ path: 'main.js', content: "require('node:fs').writeFileSync('ran.txt', 'yes');\nconsole.log('DO NOT RUN');\n" }],
    });

    await withServer(
      () => sseReply(JSON.stringify(plan)),
      async (mock) => {
        const file = sourceFile('prit("helloword")\n');

        const quietCase = caseEnv(mock);
        const result = await runCli([file], { env: quietCase.env });
        assert.equal(result.code, 0, `stderr:\n${result.stderr}`);
        assert.equal(result.stdout, '', 'compile must not execute the program');
        assert.equal(result.stderr, '', 'default output must be silent');
        assert.ok(existsSync(path.join(quietCase.outDir, 'main.js')), 'generated source should be written');
        assert.equal(existsSync(path.join(quietCase.outDir, 'ran.txt')), false, 'program must not have run');

        const logCase = caseEnv(mock);
        const logged = await runCli(['--log', file], { env: logCase.env });
        assert.equal(logged.code, 0, `stderr:\n${logged.stderr}`);
        assert.match(logged.stderr, /compiled only/);
        assert.match(logged.stderr, /shitc run /);
        assert.match(logged.stderr, /source  /);
        assert.match(logged.stderr, /files\s+main\.js/);
        assert.match(logged.stderr, /\[shitc /);

        const system = (mock.requests[0]!.body.messages as Array<{ content: string }>)[0]!;
        assert.match(system.content, /Input contract: source code only/);
        assert.match(system.content, /Prompt-injection defense/i);
        assert.match(system.content, /Shell: bash \(posix\)/);
        assert.equal((mock.requests[0]!.body.response_format as Record<string, unknown>).type, 'json_schema');
      },
    );
  });

  it('keeps generated intermediates out of the working directory by default', async () => {
    const plan = planFor({
      files: [{ path: 'shitc-cache-probe.js', content: 'console.log("probe");\n' }],
      runCommand: 'node shitc-cache-probe.js',
    });

    await withServer(
      () => sseReply(JSON.stringify(plan)),
      async (mock) => {
        const { env, configDir } = caseEnv(mock);
        delete env.SHITC_OUT_DIR;

        const result = await runCli([sourceFile('probe\n')], { env });
        assert.equal(result.code, 0, `stderr:\n${result.stderr}`);
        assert.equal(result.stdout, '');
        assert.equal(result.stderr, '');

        const buildRoot = path.join(configDir, 'build');
        const found = readdirSync(buildRoot, { recursive: true, encoding: 'utf8' }).filter(
          (entry) => path.basename(entry) === 'shitc-cache-probe.js',
        );
        assert.equal(found.length, 1, 'generated file should live under the build cache');
        assert.equal(
          existsSync(path.join(PROJECT_ROOT, 'shitc-cache-probe.js')),
          false,
          'the working directory must stay clean',
        );
      },
    );
  });

  it('runs the program only with the "run" subcommand', async () => {
    await withServer(
      () => sseReply(JSON.stringify(planFor())),
      async (mock) => {
        const { env } = caseEnv(mock);
        const result = await runCli(['run', sourceFile('prit("helloword")\n')], { env });
        assert.equal(result.code, 0, `stderr:\n${result.stderr}`);
        assert.equal(result.stdout, 'hello from shitc\n');
        assert.equal(result.stderr, '', 'default output is program output only');
      },
    );
  });

  it('shows program output and fails with exit 65 when the program exits non-zero', async () => {
    const plan = planFor({ files: [{ path: 'main.js', content: 'console.error("BOOM"); process.exit(2);\n' }] });

    await withServer(
      () => sseReply(JSON.stringify(plan)),
      async (mock) => {
        const { env } = caseEnv(mock);
        const result = await runCli(['run', sourceFile('explode\n')], { env });
        assert.equal(result.code, 65, `stderr:\n${result.stderr}`);
        assert.match(result.stderr, /BOOM/);
        assert.match(result.stderr, /run failed \(exit code 2\)/);
        assert.doesNotMatch(result.stderr, /output kept in/);
        assert.doesNotMatch(result.stderr, /shitc 0\.2\.0 ·/);
      },
    );
  });

  it('reports a natural-language request as a syntax error (exit 65, not ICE)', async () => {
    await withServer(
      () => sseReply(JSON.stringify(REJECTED_PLAN)),
      async (mock) => {
        const { env } = caseEnv(mock);
        const file = sourceFile('请写一个快速排序算法\n');
        const result = await runCli([file], { env });

        assert.equal(result.code, 65, `stderr:\n${result.stderr}`);
        assert.match(result.stderr, /:1: error: expected a ShitLang program/);
        assert.match(result.stderr, /1 error generated\./);
        assert.doesNotMatch(result.stderr, /ICE-/);
      },
    );
  });

  it('throws ICE-003 when the model answers with prose instead of JSON', async () => {
    await withServer(
      () => sseReply('I am sorry, but I cannot compile that.'),
      async (mock) => {
        const { env } = caseEnv(mock);
        const result = await runCli([sourceFile('prit("x")\n')], { env });
        assert.equal(result.code, 70, `stderr:\n${result.stderr}`);
        assert.match(result.stderr, /ICE-003/);
      },
    );
  });

  it('throws ICE-006 when the model emits a path traversal', async () => {
    const plan = planFor({ files: [{ path: '../../evil.js', content: 'x\n' }], entry: '../../evil.js' });

    await withServer(
      () => sseReply(JSON.stringify(plan)),
      async (mock) => {
        const { env } = caseEnv(mock);
        const result = await runCli([sourceFile('escape\n')], { env });
        assert.equal(result.code, 70);
        assert.match(result.stderr, /ICE-006/);
      },
    );
  });

  it('supports --emit-only without building or executing', async () => {
    const plan = planFor({ files: [{ path: 'main.js', content: 'console.log("SHOULD NOT RUN"); process.exit(9);\n' }] });

    await withServer(
      () => sseReply(JSON.stringify(plan)),
      async (mock) => {
        const { env, outDir } = caseEnv(mock);
        const result = await runCli(['--emit-only', sourceFile('nope\n')], { env });
        assert.equal(result.code, 0, `stderr:\n${result.stderr}`);
        assert.equal(result.stdout, '');
        assert.match(result.stderr, /--emit-only/);

        assert.match(result.stderr, /SHOULD NOT RUN/);
        assert.match(readFileSync(path.join(outDir, 'main.js'), 'utf8'), /SHOULD NOT RUN/);
      },
    );
  });

  it('-s writes the generated source file without needing a compiler', async () => {
    const plan = {
      status: 'ok',
      diagnostics: [],
      language: 'c',
      runtimeKind: 'compiled',

      compileCommand: 'shitc-missing-compiler-xyz main.c -o main',
      runCommand: './main',
      files: [{ path: 'main.c', content: 'int main(void) { return 0; }\n' }],
      entry: 'main.c',
      notes: 'c target',
    };
    const target = path.join(tempRoot, 'source-only', 'main.c');

    await withServer(
      () => sseReply(JSON.stringify(plan)),
      async (mock) => {
        const { env } = caseEnv(mock);
        const result = await runCli(['-s', '-o', target, sourceFile('c\n')], { env });
        assert.equal(result.code, 0, `stderr:\n${result.stderr}`);
        assert.equal(result.stdout, '');
        assert.equal(result.stderr, '');
        assert.ok(statSync(target).isFile(), '-s -o must write a source file');
        assert.match(readFileSync(target, 'utf8'), /int main/);
      },
    );
  });

  it('-s -d writes all generated sources into a directory', async () => {
    const outDir = path.join(tempRoot, 'source-only-dir');
    await withServer(
      () => sseReply(JSON.stringify(planFor())),
      async (mock) => {
        const { env } = caseEnv(mock);
        const result = await runCli(['-s', '-d', outDir, sourceFile('prit("hi")\n')], { env });
        assert.equal(result.code, 0, `stderr:\n${result.stderr}`);
        assert.ok(existsSync(path.join(outDir, 'main.js')));
      },
    );
  });

  it('hints at missing toolchains when the build exits 127', async () => {
    const plan = {
      status: 'ok',
      diagnostics: [],
      language: 'c',
      runtimeKind: 'compiled',
      compileCommand: 'shitc-unknown-compiler-xyz main.c -o main',
      runCommand: './main',
      files: [{ path: 'main.c', content: 'int main(void) { return 0; }\n' }],
      entry: 'main.c',
      notes: 'c target',
    };

    await withServer(
      () => sseReply(JSON.stringify(plan)),
      async (mock) => {
        const { env } = caseEnv(mock);
        const result = await runCli([sourceFile('c\n')], { env });
        assert.equal(result.code, 65, `stderr:\n${result.stderr}`);
        assert.match(result.stderr, /build failed \(exit code 127\)/);
        assert.match(result.stderr, /command not found/);
        assert.match(result.stderr, /-s to emit source only/);
      },
    );
  });

  it('--json reports mode/ran/stages for compile-only and run', async () => {
    await withServer(
      () => sseReply(JSON.stringify(planFor())),
      async (mock) => {
        const compileCase = caseEnv(mock);
        const compiled = await runCli(['--json', sourceFile('prit("hi")\n')], { env: compileCase.env });
        assert.equal(compiled.code, 0, `stderr:\n${compiled.stderr}`);
        const compilePayload = JSON.parse(compiled.stdout) as {
          ok: boolean;
          mode: string;
          ran: boolean;
          outDir: string;
          plan: { language: string; entry: string };
          stages: unknown[];
        };
        assert.equal(compilePayload.ok, true);
        assert.equal(compilePayload.mode, 'compile');
        assert.equal(compilePayload.ran, false);
        assert.equal(compilePayload.stages.length, 0);
        assert.equal(compilePayload.outDir, compileCase.outDir);

        const runCase = caseEnv(mock);
        const ran = await runCli(['--json', 'run', sourceFile('prit("hi")\n')], { env: runCase.env });
        assert.equal(ran.code, 0, `stderr:\n${ran.stderr}`);
        const runPayload = JSON.parse(ran.stdout) as {
          ok: boolean;
          mode: string;
          ran: boolean;
          stages: Array<{ name: string; stdout: string; exitCode: number }>;
        };
        assert.equal(runPayload.mode, 'run');
        assert.equal(runPayload.ran, true);
        assert.equal(runPayload.stages[0]?.name, 'run');
        assert.equal(runPayload.stages[0]?.exitCode, 0);
        assert.match(runPayload.stages[0]?.stdout ?? '', /hello from shitc/);
      },
    );
  });

  it('--log prints compiler phase logs', async () => {
    await withServer(
      () => sseReply(JSON.stringify(planFor())),
      async (mock) => {
        const { env } = caseEnv(mock);
        const result = await runCli(['--log', sourceFile('prit("hi")\n')], { env });
        assert.equal(result.code, 0, `stderr:\n${result.stderr}`);
        assert.match(result.stderr, /\[shitc\s+[\d.]+s\]/);
        for (const phase of ['start', 'config', 'shell', 'prompt', 'request', 'ir', 'write', 'done']) {
          assert.match(result.stderr, new RegExp(`\\b${phase}\\b`), `missing log phase ${phase}`);
        }
      },
    );
  });

  it('`-log` (single dash) works too', async () => {
    await withServer(
      () => sseReply(JSON.stringify(planFor())),
      async (mock) => {
        const { env } = caseEnv(mock);
        const result = await runCli(['-log', sourceFile('prit("hi")\n')], { env });
        assert.equal(result.code, 0, `stderr:\n${result.stderr}`);
        assert.match(result.stderr, /\[shitc/);
      },
    );
  });

  it('-o <path> writes the entry source file for interpreted targets', async () => {
    const target = path.join(tempRoot, 'entry-out', 'myprog.js');
    await withServer(
      () => sseReply(JSON.stringify(planFor())),
      async (mock) => {
        const { env } = caseEnv(mock);
        const result = await runCli(['-o', target, sourceFile('prit("hi")\n')], { env });
        assert.equal(result.code, 0, `stderr:\n${result.stderr}`);
        assert.ok(statSync(target).isFile(), '-o must be a file, not a directory');
        assert.match(readFileSync(target, 'utf8'), /hello from shitc/);
      },
    );
  });

  it('run -o <path> exports the entry source and still executes', async () => {
    const target = path.join(tempRoot, 'run-entry', 'main.js');
    await withServer(
      () => sseReply(JSON.stringify(planFor())),
      async (mock) => {
        const { env } = caseEnv(mock);
        const result = await runCli(['run', '-o', target, sourceFile('prit("hi")\n')], { env });
        assert.equal(result.code, 0, `stderr:\n${result.stderr}`);
        assert.match(result.stdout, /hello from shitc/);
        assert.ok(statSync(target).isFile());
        assert.match(readFileSync(target, 'utf8'), /hello from shitc/);
      },
    );
  });

  it('-d <dir> writes all generated files into the directory (interpreted)', async () => {
    const outDir = path.join(tempRoot, 'outdir-interpreted');
    await withServer(
      () => sseReply(JSON.stringify(planFor())),
      async (mock) => {
        const { env } = caseEnv(mock);
        const result = await runCli(['-d', outDir, sourceFile('prit("hi")\n')], { env });
        assert.equal(result.code, 0, `stderr:\n${result.stderr}`);
        assert.ok(existsSync(path.join(outDir, 'main.js')));
      },
    );
  });

  it('-o <path> on a compiled target is the executable path (gcc-style)', async (t) => {
    if (!hasCommand('gcc')) return t.skip('gcc not available');

    await withServer(
      () => sseReply(JSON.stringify(C_PLAN)),
      async (mock) => {
        const { env, configDir } = caseEnv(mock);
        delete env.SHITC_OUT_DIR;
        const cwd = path.join(tempRoot, 'bin-cwd');
        mkdirSync(cwd, { recursive: true });
        const bin = path.join(cwd, 'myprog');

        const result = await runCli(['-o', bin, sourceFile('c\n')], { env, cwd });
        assert.equal(result.code, 0, `stderr:\n${result.stderr}`);
        assert.equal(result.stdout, '');
        assert.equal(result.stderr, '');

        assert.ok(existsSync(bin), 'executable should be written to the -o path');
        assert.ok(statSync(bin).isFile(), '-o must be a file, not a directory');
        assert.equal(existsSync(path.join(cwd, 'main.c')), false, 'sources stay in the cache');

        const cached = readdirSync(path.join(configDir, 'build'), { recursive: true, encoding: 'utf8' });
        assert.ok(cached.some((entry) => path.basename(entry) === 'main.c'));
        assert.equal(cached.some((entry) => path.basename(entry) === 'main'), false);
      },
    );
  });

  it('-d <dir> keeps sources and the executable together', async (t) => {
    if (!hasCommand('gcc')) return t.skip('gcc not available');

    await withServer(
      () => sseReply(JSON.stringify(C_PLAN)),
      async (mock) => {
        const { env, configDir } = caseEnv(mock);
        delete env.SHITC_OUT_DIR;
        const cwd = path.join(tempRoot, 'bundle-cwd');
        mkdirSync(cwd, { recursive: true });
        const outDir = path.join(tempRoot, 'bundle-out');

        const result = await runCli(['-d', outDir, sourceFile('c\n')], { env, cwd });
        assert.equal(result.code, 0, `stderr:\n${result.stderr}`);
        assert.ok(existsSync(path.join(outDir, 'main.c')));
        assert.ok(existsSync(path.join(outDir, 'main')));
        assert.equal(existsSync(path.join(cwd, 'main')), false, 'nothing is exported to cwd with -d');
        assert.equal(existsSync(path.join(configDir, 'build')), false, 'no cache dir is used with -d');
      },
    );
  });

  it('compiles from stdin with "-"', async () => {
    await withServer(
      () => sseReply(JSON.stringify(planFor())),
      async (mock) => {
        const { env } = caseEnv(mock);
        const result = await runCli(['run', '-'], { env, stdin: 'prit("helloword")\n' });
        assert.equal(result.code, 0, `stderr:\n${result.stderr}`);
        assert.match(result.stdout, /hello from shitc/);
        const user = (mock.requests[0]!.body.messages as Array<{ content: string }>)[1]!;
        assert.match(user.content, /prit\("helloword"\)/);
      },
    );
  });

  it('reads the endpoint from ~/.shitc/config.json instead of env', async () => {
    await withServer(
      () => jsonReply(JSON.stringify(planFor())),
      async (mock) => {
        const { env, configDir: dir, outDir } = caseEnv(mock);
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          path.join(dir, 'config.json'),
          `${JSON.stringify({ baseUrl: `${mock.url}/v1`, apiKey: 'file-key', model: 'file-model' }, null, 2)}\n`,
          { mode: 0o600 },
        );
        const fileOnlyEnv = {
          SHITC_CONFIG_DIR: dir,
          SHITC_OUT_DIR: outDir,
          SHITC_SHELL: process.platform === 'win32' ? 'cmd' : 'bash',
        };

        const result = await runCli(['run', sourceFile('prit("hi")\n')], { env: fileOnlyEnv });
        assert.equal(result.code, 0, `stderr:\n${result.stderr}`);
        assert.equal(mock.requests[0]!.body.model, 'file-model');
        assert.match(result.stdout, /hello from shitc/);
      },
    );
  });

  it('accepts an executable source file with a shitc shebang', async () => {
    await withServer(
      () => sseReply(JSON.stringify(planFor())),
      async (mock) => {
        const { env } = caseEnv(mock);
        const file = sourceFile('#!/usr/bin/env shitc\nprit("helloword")\n', 'executable.shit');
        const result = await runCli(['run', file], { env });

        assert.equal(result.code, 0, `stderr:\n${result.stderr}`);
        assert.match(result.stdout, /hello from shitc/);

        const user = (mock.requests[0]!.body.messages as Array<{ content: string }>)[1]!;
        assert.doesNotMatch(user.content, /#!\/usr\/bin\/env shitc/);
        assert.match(user.content, /prit\("helloword"\)/);
      },
    );
  });

  it('fails with ICE-001 when no api key is configured for a remote endpoint', async () => {
    const result = await runCli([sourceFile('prit("x")\n')], {
      env: {
        SHITC_CONFIG_DIR: path.join(tempRoot, 'empty-config'),
        SHITC_OUT_DIR: path.join(tempRoot, 'empty-out'),
        SHITC_BASE_URL: 'https://api.openai.com/v1',
        SHITC_API_KEY: '',
        OPENAI_API_KEY: '',
        SHITC_MODEL: 'gpt-4o-mini',
      },
    });

    assert.equal(result.code, 70);
    assert.match(result.stderr, /ICE-001/);
    assert.match(result.stderr, /no API key configured/);
    assert.match(result.stderr, /shitc init/);
  });

  it('supports compiled languages (C via gcc)', async (t) => {
    if (!hasCommand('gcc')) return t.skip('gcc not available');

    const plan = {
      status: 'ok',
      diagnostics: [],
      language: 'c',
      runtimeKind: 'compiled',
      compileCommand: 'gcc main.c -o main',
      runCommand: './main',
      files: [{ path: 'main.c', content: '#include <stdio.h>\nint main(void) { puts("compiled ok"); return 0; }\n' }],
      entry: 'main.c',
      notes: 'c target',
    };

    await withServer(
      () => sseReply(JSON.stringify(plan)),
      async (mock) => {
        const compileCase = caseEnv(mock);
        const compiled = await runCli(['--log', sourceFile('print compiled ok\n')], { env: compileCase.env });
        assert.equal(compiled.code, 0, `stderr:\n${compiled.stderr}`);
        assert.equal(compiled.stdout, '', 'compile mode must not run the binary');
        assert.match(compiled.stderr, /gcc main\.c -o main/);
        assert.match(compiled.stderr, /built/);
        assert.ok(existsSync(path.join(compileCase.outDir, 'main.c')));
        assert.ok(existsSync(path.join(compileCase.outDir, 'main')));

        const runCase = caseEnv(mock);
        const ran = await runCli(['run', sourceFile('print compiled ok\n')], { env: runCase.env });
        assert.equal(ran.code, 0, `stderr:\n${ran.stderr}`);
        assert.match(ran.stdout, /compiled ok/);
      },
    );
  });

  it('exports the built executable to the working directory but keeps sources in the build cache', async (t) => {
    if (!hasCommand('gcc')) return t.skip('gcc not available');

    const plan = {
      status: 'ok',
      diagnostics: [],
      language: 'c',
      runtimeKind: 'compiled',
      compileCommand: 'gcc main.c -o main',
      runCommand: './main',
      files: [{ path: 'main.c', content: '#include <stdio.h>\nint main(void) { puts("exported"); return 0; }\n' }],
      entry: 'main.c',
      notes: 'c target',
    };

    await withServer(
      () => sseReply(JSON.stringify(plan)),
      async (mock) => {
        const compileCase = caseEnv(mock);
        delete compileCase.env.SHITC_OUT_DIR;
        const cwd = path.join(tempRoot, 'export-cwd');
        mkdirSync(cwd, { recursive: true });

        const compiled = await runCli([sourceFile('c\n')], { env: compileCase.env, cwd });
        assert.equal(compiled.code, 0, `stderr:\n${compiled.stderr}`);
        assert.equal(compiled.stdout, '');
        assert.equal(compiled.stderr, '');
        assert.ok(existsSync(path.join(cwd, 'main')), 'built executable is exported to cwd');
        assert.equal(existsSync(path.join(cwd, 'main.c')), false, 'sources stay in the build cache');

        const buildRoot = path.join(compileCase.configDir, 'build');
        const cached = readdirSync(buildRoot, { recursive: true, encoding: 'utf8' });
        assert.equal(
          cached.filter((entry) => path.basename(entry) === 'main.c').length,
          1,
          'sources stay in the build cache',
        );
        assert.equal(
          cached.filter((entry) => path.basename(entry) === 'main').length,
          0,
          'the executable is moved out of the build cache',
        );

        const runCase = caseEnv(mock);
        delete runCase.env.SHITC_OUT_DIR;
        const runCwd = path.join(tempRoot, 'export-run-cwd');
        mkdirSync(runCwd, { recursive: true });
        const ran = await runCli(['run', sourceFile('c\n')], { env: runCase.env, cwd: runCwd });
        assert.equal(ran.code, 0, `stderr:\n${ran.stderr}`);
        assert.match(ran.stdout, /exported/);
        assert.ok(existsSync(path.join(runCwd, 'main')));
      },
    );
  });

  it('--json reports syntax diagnostics with exit 65', async () => {
    await withServer(
      () => sseReply(JSON.stringify(REJECTED_PLAN)),
      async (mock) => {
        const { env } = caseEnv(mock);
        const result = await runCli(['--json', sourceFile('请写一个排序算法\n')], { env });
        assert.equal(result.code, 65, `stderr:\n${result.stderr}`);

        const payload = JSON.parse(result.stdout) as {
          ok: boolean;
          error: { kind: string; message: string; diagnostics: Array<{ line: number; message: string }> };
        };
        assert.equal(payload.ok, false);
        assert.equal(payload.error.kind, 'syntax');
        assert.equal(payload.error.diagnostics[0]?.line, 1);
        assert.match(payload.error.diagnostics[0]?.message ?? '', /expected a ShitLang program/);
      },
    );
  });

  it('shows build output and exits 65 when the build fails', async (t) => {
    if (!hasCommand('gcc')) return t.skip('gcc not available');

    const plan = {
      status: 'ok',
      diagnostics: [],
      language: 'c',
      runtimeKind: 'compiled',
      compileCommand: 'gcc main.c -o main',
      runCommand: './main',
      files: [{ path: 'main.c', content: 'int main(void) { this is not c; }\n' }],
      entry: 'main.c',
      notes: 'broken c',
    };

    await withServer(
      () => sseReply(JSON.stringify(plan)),
      async (mock) => {
        const { env, outDir } = caseEnv(mock);
        const result = await runCli([sourceFile('broken c\n')], { env });
        assert.equal(result.code, 65, `stderr:\n${result.stderr}`);
        assert.match(result.stderr, /build failed \(exit code 1\)/);
        assert.match(result.stderr, /error:/);
        assert.equal(existsSync(path.join(outDir, 'main')), false, 'no binary on compile failure');
      },
    );
  });

  it('init --reasoning saves the CoT parameter', async () => {
    const configDir = path.join(tempRoot, 'init-reasoning', 'cfg');
    const result = await runCli(
      [
        'init',
        '--base-url',
        'https://api.example.test/v1',
        '--api-key',
        'sk-test',
        '--model',
        'gpt-test',
        '--reasoning',
        'reasoning_effort=high',
      ],
      { env: { SHITC_CONFIG_DIR: configDir } },
    );

    assert.equal(result.code, 0, `stderr:\n${result.stderr}`);
    const saved = JSON.parse(readFileSync(path.join(configDir, 'config.json'), 'utf8')) as {
      reasoningParam: string;
      reasoningValue: string;
    };
    assert.equal(saved.reasoningParam, 'reasoning_effort');
    assert.equal(saved.reasoningValue, 'high');
  });

  it('init without --reasoning leaves CoT disabled', async () => {
    const configDir = path.join(tempRoot, 'init-no-reasoning', 'cfg');
    const result = await runCli(
      ['init', '--base-url', 'http://127.0.0.1:9/v1', '--api-key', 'x', '--model', 'm'],
      { env: { SHITC_CONFIG_DIR: configDir } },
    );

    assert.equal(result.code, 0, `stderr:\n${result.stderr}`);
    const saved = JSON.parse(readFileSync(path.join(configDir, 'config.json'), 'utf8')) as {
      reasoningParam: string;
      reasoningValue: string;
    };
    assert.equal(saved.reasoningParam, '');
    assert.equal(saved.reasoningValue, '');
  });

  it('rejects --reasoning without param=value', async () => {
    const result = await runCli(
      ['init', '--base-url', 'http://127.0.0.1:9/v1', '--api-key', 'x', '--model', 'm', '--reasoning', 'reasoning_effort'],
      { env: { SHITC_CONFIG_DIR: path.join(tempRoot, 'init-bad-reasoning') } },
    );
    assert.equal(result.code, 64);
    assert.match(result.stderr, /--reasoning expects <param>=<value>/);
  });

  it('config set/get works for the reasoning parameter', async () => {
    const configDir = path.join(tempRoot, 'cfg-reasoning', 'cfg');
    const env = { SHITC_CONFIG_DIR: configDir };

    await runCli(['config', 'set', 'reasoningParam', 'reasoning_effort'], { env });
    await runCli(['config', 'set', 'reasoningValue', 'low'], { env });

    const param = await runCli(['config', 'get', 'reasoningParam'], { env });
    assert.equal(param.stdout.trim(), 'reasoning_effort');
    const value = await runCli(['config', 'get', 'reasoningValue'], { env });
    assert.equal(value.stdout.trim(), 'low');
  });

  it('rejects the removed "eval" command with a migration hint', async () => {
    const result = await runCli(['eval', 'prit("x")']);
    assert.equal(result.code, 64);
    assert.match(result.stderr, /"eval" command was removed/);
    assert.match(result.stderr, /hello\.shit/);
  });

  it('rejects unknown options with exit 64', async () => {
    const result = await runCli(['--definitely-not-an-option']);
    assert.equal(result.code, 64);
    assert.match(result.stderr, /unknown option/);
  });

  it('prints help and version without any configuration', async () => {
    const help = await runCli(['--help']);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /Usage/);
    assert.match(help.stdout, /Exit codes/);

    const version = await runCli(['--version']);
    assert.equal(version.code, 0);
    assert.match(version.stdout, /^shitc \d+\.\d+\.\d+/);
  });

});
