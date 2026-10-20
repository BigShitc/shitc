import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildShellInvocation,
  detectShell,
  normalizeShellName,
  prepareCommand,
  resolveShell,
  shellKindOf,
  shellExecForm,
  type ShellInfo,
} from '../src/shell.js';

function fakeShell(overrides: Partial<ShellInfo>): ShellInfo {
  return {
    name: 'bash',
    kind: 'posix',
    path: '/bin/bash',
    found: true,
    platform: 'linux',
    display: 'bash (posix)',
    ...overrides,
  };
}

describe('shell detection', () => {
  it('returns a usable shell for the current host', () => {
    const shell = detectShell();
    assert.ok(shell.name.length > 0);
    assert.ok(['posix', 'cmd', 'powershell'].includes(shell.kind));
    assert.ok(shell.display.includes(shell.name));
  });

  it('honors an explicit override', () => {
    const pwsh = detectShell('pwsh');
    assert.equal(pwsh.kind, 'powershell');
    assert.equal(pwsh.name, 'pwsh');

    const cmd = detectShell('cmd');
    assert.equal(cmd.kind, 'cmd');
  });

  it('honors SHITC_SHELL', () => {
    const previous = process.env.SHITC_SHELL;
    process.env.SHITC_SHELL = 'fish';
    try {
      assert.equal(detectShell().name, 'fish');
    } finally {
      if (previous === undefined) delete process.env.SHITC_SHELL;
      else process.env.SHITC_SHELL = previous;
    }
  });

  it('resolves an absolute shell path', () => {
    const shell = resolveShell('/bin/sh');
    assert.equal(shell.kind, 'posix');
    assert.equal(shell.found, true);
  });

  it('keeps an unknown shell name but marks it unfound', () => {
    const shell = resolveShell('definitely-not-a-real-shell-xyz');
    assert.equal(shell.found, false);
    assert.equal(shell.kind, 'posix');
  });

  it('normalizes names and kinds', () => {
    assert.equal(normalizeShellName('C:\\Windows\\System32\\cmd.exe'), 'cmd');
    assert.equal(normalizeShellName('/bin/zsh'), 'zsh');
    assert.equal(shellKindOf('pwsh'), 'powershell');
    assert.equal(shellKindOf('powershell'), 'powershell');
    assert.equal(shellKindOf('cmd'), 'cmd');
    assert.equal(shellKindOf('zsh'), 'posix');
  });
});

describe('shell invocation', () => {
  it('builds POSIX invocations with -c', () => {
    const invocation = buildShellInvocation('python3 main.py', fakeShell({}));
    assert.deepEqual(invocation, { file: '/bin/bash', args: ['-c', 'python3 main.py'] });
  });

  it('builds cmd invocations with /d /s /c', () => {
    const invocation = buildShellInvocation('node main.js', fakeShell({ name: 'cmd', kind: 'cmd', path: 'C:\\Windows\\System32\\cmd.exe' }));
    assert.deepEqual(invocation.args, ['/d', '/s', '/c', 'node main.js']);
  });

  it('builds PowerShell invocations with -Command', () => {
    const invocation = buildShellInvocation('node main.js', fakeShell({ name: 'pwsh', kind: 'powershell', path: '/usr/bin/pwsh' }));
    assert.deepEqual(invocation.args, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'node main.js']);
  });

  it('describes how commands are executed', () => {
    assert.equal(shellExecForm(fakeShell({})), 'bash -c "<command>"');
    assert.equal(shellExecForm(fakeShell({ name: 'cmd', kind: 'cmd' })), 'cmd.exe /d /s /c "<command>"');
    assert.equal(
      shellExecForm(fakeShell({ name: 'pwsh', kind: 'powershell' })),
      'pwsh -NoLogo -NoProfile -NonInteractive -Command "<command>"',
    );
  });

  it('adds UTF-8 console setup on Windows only', () => {
    const cmd = fakeShell({ name: 'cmd', kind: 'cmd', path: 'cmd.exe', platform: 'win32' });
    assert.equal(prepareCommand('node main.js', cmd), 'chcp 65001>nul & node main.js');

    const pwsh = fakeShell({ name: 'pwsh', kind: 'powershell', platform: 'win32' });
    assert.match(prepareCommand('node main.js', pwsh), /^\S*OutputEncoding.*; node main\.js$/);

    assert.equal(prepareCommand('node main.js', fakeShell({})), 'node main.js');
  });
});
