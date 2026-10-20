import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { InternalCompilerError } from '../src/errors.js';
import { OutputCapture, exportArtifact, exportArtifactFile, findRunArtifact, prepareOutputDir, pruneBuildDirs, removeBuiltArtifact, resolveOutputDir, runStage, writeArtifacts } from '../src/executor.js';
import { detectShell } from '../src/shell.js';
import { makeTempDir, removeDir } from './helpers.js';

let dir = '';
const savedEnv: Record<string, string | undefined> = {};

before(() => {
  dir = makeTempDir('shitc-exec-');
  for (const key of ['SHITC_CONFIG_DIR', 'SHITC_OUT_DIR', 'SHITC_ARTIFACT_DIR']) {
    savedEnv[key] = process.env[key];
  }
  process.env.SHITC_CONFIG_DIR = path.join(dir, 'cfg');
  delete process.env.SHITC_OUT_DIR;
  delete process.env.SHITC_ARTIFACT_DIR;
});

after(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  removeDir(dir);
});

const POSIX = process.platform !== 'win32';

describe('output directories', () => {
  it('resolves an explicit directory (-o)', () => {
    const target = path.join(dir, 'explicit');
    assert.equal(resolveOutputDir(target), target);
    assert.ok(existsSync(target));
  });

  it('creates nested explicit directories', () => {
    const target = path.join(dir, 'a', 'b', 'c');
    assert.equal(resolveOutputDir(target), target);
    assert.ok(existsSync(target));
  });

  it('creates a fresh per-compile build directory under ~/.shitc/build', () => {
    const first = resolveOutputDir();
    const second = resolveOutputDir();
    const root = path.join(dir, 'cfg', 'build');

    assert.equal(path.dirname(first), root);
    assert.match(path.basename(first), /^\d{8}-\d{6}-[0-9a-z]{4}$/);
    assert.ok(existsSync(first));
    assert.notEqual(first, second, 'every compile gets its own directory');
    assert.ok(second.startsWith(root));
  });

  it('prunes old build directories, keeping the newest 20', () => {
    const root = path.join(dir, 'cfg', 'build');
    for (let index = 0; index < 25; index += 1) resolveOutputDir();

    const remaining = readdirSync(root).filter((name) => /^\d{8}-\d{6}-[0-9a-z]{4}$/.test(name));
    assert.ok(remaining.length <= 20, `expected <= 20 build dirs, found ${remaining.length}`);

    pruneBuildDirs(root, 5);
    const afterPrune = readdirSync(root).filter((name) => /^\d{8}-\d{6}-[0-9a-z]{4}$/.test(name));
    assert.ok(afterPrune.length <= 5, `expected <= 5 build dirs, found ${afterPrune.length}`);
  });

  it('uses SHITC_OUT_DIR verbatim when set', () => {
    const target = path.join(dir, 'env-out');
    process.env.SHITC_OUT_DIR = target;
    try {
      assert.equal(resolveOutputDir(), target);
      assert.ok(existsSync(target));
    } finally {
      delete process.env.SHITC_OUT_DIR;
    }
  });

  it('refuses a path that is a file', () => {
    const file = path.join(dir, 'not-a-dir');
    writeFileSync(file, 'x');
    assert.throws(
      () => prepareOutputDir(file),
      (err: unknown) => err instanceof InternalCompilerError && err.code === 'ICE-007',
    );
  });
});

describe('writing generated files', () => {
  it('writes nested files and reports sizes', () => {
    const target = prepareOutputDir(path.join(dir, 'write'));
    const written = writeArtifacts(target, [
      { path: 'main.py', content: 'print(1)\n' },
      { path: 'pkg/util.py', content: 'x = 1\n' },
    ]);

    assert.equal(written.length, 2);
    assert.equal(readFileSync(path.join(target, 'pkg/util.py'), 'utf8'), 'x = 1\n');
    assert.equal(written[0]?.bytes, Buffer.byteLength('print(1)\n'));
  });

  it('overwrites existing files, like a compiler', () => {
    const target = prepareOutputDir(path.join(dir, 'overwrite'));
    writeArtifacts(target, [{ path: 'main.py', content: 'old\n' }]);
    writeArtifacts(target, [{ path: 'main.py', content: 'new\n' }]);
    assert.equal(readFileSync(path.join(target, 'main.py'), 'utf8'), 'new\n');
  });

  it('refuses to escape the output directory', () => {
    const target = prepareOutputDir(path.join(dir, 'escape'));
    assert.throws(
      () => writeArtifacts(target, [{ path: '../outside.txt', content: 'x' }]),
      (err: unknown) => err instanceof InternalCompilerError && err.code === 'ICE-006',
    );
    assert.equal(existsSync(path.join(dir, 'outside.txt')), false);
  });
});

describe('stage execution', () => {
  it('captures stdout, stderr and the exit code', async (t) => {
    if (!POSIX) return t.skip('POSIX shell required');
    const shell = detectShell('bash');
    const cwd = prepareOutputDir(path.join(dir, 'stage'));

    const result = await runStage({
      name: 'run',
      command: 'echo out; echo err >&2; exit 3',
      cwd,
      shell,
      timeoutMs: 10_000,
      live: false,
    });

    assert.equal(result.exitCode, 3);
    assert.equal(result.succeeded, false);
    assert.match(result.stdout, /out/);
    assert.match(result.stderr, /err/);
    assert.equal(result.timedOut, false);
  });

  it('marks successful stages as succeeded', async (t) => {
    if (!POSIX) return t.skip('POSIX shell required');
    const cwd = prepareOutputDir(path.join(dir, 'stage-ok'));
    const result = await runStage({ name: 'compile', command: 'echo built', cwd, shell: detectShell('bash'), timeoutMs: 10_000, live: false });
    assert.equal(result.exitCode, 0);
    assert.equal(result.succeeded, true);
    assert.match(result.stdout, /built/);
  });

  it('kills commands that exceed the timeout', async (t) => {
    if (!POSIX) return t.skip('POSIX shell required');
    const cwd = prepareOutputDir(path.join(dir, 'stage-timeout'));
    const started = Date.now();
    const result = await runStage({ name: 'run', command: 'sleep 5', cwd, shell: detectShell('bash'), timeoutMs: 250, live: false });
    assert.equal(result.timedOut, true);
    assert.equal(result.succeeded, false);
    assert.ok(Date.now() - started < 3000, 'timeout should kill the process promptly');
  });

  it('runs commands with the output directory as cwd', async (t) => {
    if (!POSIX) return t.skip('POSIX shell required');
    const cwd = prepareOutputDir(path.join(dir, 'stage-cwd'));
    writeFileSync(path.join(cwd, 'marker.txt'), 'here');
    const result = await runStage({ name: 'run', command: 'cat marker.txt', cwd, shell: detectShell('bash'), timeoutMs: 10_000, live: false });
    assert.equal(result.stdout.trim(), 'here');
  });
});

describe('exporting built artifacts', () => {
  it('finds the executable referenced by runCommand', () => {
    const buildDir = prepareOutputDir(path.join(dir, 'artifact-find'));
    writeFileSync(path.join(buildDir, 'main'), 'binary\n');
    writeFileSync(path.join(buildDir, 'main.py'), 'print(1)\n');

    assert.equal(findRunArtifact(buildDir, './main'), 'main');
    assert.equal(findRunArtifact(buildDir, './main --verbose'), 'main');
    assert.equal(findRunArtifact(buildDir, 'bash main.sh'), null, 'interpreter token is not a built file');
    assert.equal(findRunArtifact(buildDir, 'python3 main.py'), null);
    assert.equal(findRunArtifact(buildDir, 'java Main'), null);
    assert.equal(findRunArtifact(buildDir, './missing'), null);
  });

  it('copies the built executable to the target directory', () => {
    const buildDir = prepareOutputDir(path.join(dir, 'artifact-copy'));
    const targetDir = prepareOutputDir(path.join(dir, 'artifact-target'));
    writeFileSync(path.join(buildDir, 'main'), 'binary-bytes\n');

    const exported = exportArtifact(buildDir, 'main', targetDir);
    assert.equal(exported, path.join(targetDir, 'main'));
    assert.equal(readFileSync(exported, 'utf8'), 'binary-bytes\n');
  });

  it('removes the exported executable from the cache, leaving sources', () => {
    const buildDir = prepareOutputDir(path.join(dir, 'artifact-remove'));
    writeFileSync(path.join(buildDir, 'main'), 'binary\n');
    writeFileSync(path.join(buildDir, 'main.c'), 'int main(void){return 0;}\n');

    removeBuiltArtifact(buildDir, 'main');
    assert.equal(existsSync(path.join(buildDir, 'main')), false);
    assert.equal(existsSync(path.join(buildDir, 'main.c')), true);
  });

  it('copies the built executable to an exact file path (-o)', () => {
    const buildDir = prepareOutputDir(path.join(dir, 'artifact-file'));
    writeFileSync(path.join(buildDir, 'main'), 'binary-bytes\n');
    const target = path.join(dir, 'bin', 'myprog');

    const exported = exportArtifactFile(buildDir, 'main', target);
    assert.equal(exported, target);
    assert.equal(readFileSync(exported, 'utf8'), 'binary-bytes\n');
    assert.ok(statSync(exported).isFile());
  });

  it('refuses to export outside the target directory', () => {
    const buildDir = prepareOutputDir(path.join(dir, 'artifact-escape'));
    const targetDir = prepareOutputDir(path.join(dir, 'artifact-escape-target'));
    writeFileSync(path.join(buildDir, 'evil'), 'x\n');

    assert.throws(
      () => exportArtifact(buildDir, '../evil', targetDir),
      (err: unknown) => err instanceof InternalCompilerError && err.code === 'ICE-006',
    );
  });
});

describe('OutputCapture', () => {
  it('keeps small output intact', () => {
    const capture = new OutputCapture();
    capture.push(Buffer.from('hello '));
    capture.push(Buffer.from('world'));
    assert.equal(capture.toString(), 'hello world');
    assert.equal(capture.truncated, false);
    assert.equal(capture.total, 11);
  });

  it('keeps head and tail for oversized output', () => {
    const capture = new OutputCapture(16, 16);
    capture.push(Buffer.from('A'.repeat(16)));
    capture.push(Buffer.from('B'.repeat(1000)));
    capture.push(Buffer.from('C'.repeat(16)));
    const text = capture.toString();
    assert.equal(capture.truncated, true);
    assert.ok(text.startsWith('A'.repeat(16)));
    assert.ok(text.endsWith('C'.repeat(16)));
    assert.match(text, /output truncated/);
  });
});
