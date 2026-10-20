import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { isWindows } from './util.js';
import { findOnPath } from './which.js';

export type ShellKind = 'posix' | 'cmd' | 'powershell';

export interface ShellInfo {

  name: string;
  kind: ShellKind;

  path: string;
  found: boolean;
  platform: NodeJS.Platform;

  display: string;
}

const POWERSHELL_NAMES = new Set(['pwsh', 'powershell', 'powershell_ise', 'pwsh-preview']);
const CMD_NAMES = new Set(['cmd', 'cmd.exe']);

export function normalizeShellName(raw: string): string {
  const trimmed = raw.trim().replace(/[\\/]+$/, '');
  const base = trimmed.split(/[\\/]/).pop() ?? trimmed;
  return base.replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
}

export function shellKindOf(name: string): ShellKind {
  if (POWERSHELL_NAMES.has(name)) return 'powershell';
  if (CMD_NAMES.has(name)) return 'cmd';
  return 'posix';
}

export function detectShell(override?: string): ShellInfo {
  const requested = (override ?? process.env.SHITC_SHELL ?? '').trim();
  if (requested) return resolveShell(requested);

  const fromEnvShell = (process.env.SHELL ?? '').trim();
  if (fromEnvShell) {
    const info = resolveShell(fromEnvShell);
    if (info.found) return info;
  }

  if (isWindows()) {

    const pwsh = findOnPath('pwsh');
    if (pwsh) return makeShell('pwsh', pwsh, true);
    const powershell = findOnPath('powershell');
    if (powershell) return makeShell('powershell', powershell, true);
    const comspec = process.env.ComSpec?.trim() || 'cmd.exe';
    return makeShell('cmd', comspec, Boolean(findOnPath(comspec)));
  }

  const parent = detectParentShell();
  if (parent) {
    const info = resolveShell(parent);
    if (info.found) return info;
  }

  for (const candidate of ['bash', 'zsh', 'sh']) {
    const found = findOnPath(candidate);
    if (found) return makeShell(candidate, found, true);
  }

  return makeShell('sh', '/bin/sh', false);
}

export function resolveShell(raw: string): ShellInfo {
  const name = normalizeShellName(raw);
  const direct = findOnPath(raw);
  const onPath = direct ?? findOnPath(name);
  if (onPath) return makeShell(name, onPath, true);

  if (shellKindOf(name) === 'cmd') {
    const comspec = process.env.ComSpec?.trim();
    return makeShell('cmd', comspec || 'cmd.exe', Boolean(comspec && findOnPath(comspec)));
  }
  if (shellKindOf(name) === 'powershell' && isWindows()) {
    return makeShell(name, `${name}.exe`, false);
  }
  return makeShell(name, name, false);
}

function makeShell(name: string, executable: string, found: boolean): ShellInfo {
  const kind = shellKindOf(name);
  const kindLabel = kind === 'posix' ? 'posix' : kind === 'cmd' ? 'windows cmd' : 'powershell';
  return {
    name,
    kind,
    path: path.isAbsolute(executable) ? executable : found ? findOnPath(executable) ?? executable : executable,
    found,
    platform: process.platform,
    display: `${name} (${kindLabel})`,
  };
}

function detectParentShell(): string | null {
  if (isWindows()) return null;
  try {
    const out = execFileSync('ps', ['-o', 'comm=', '-p', String(process.ppid)], {
      encoding: 'utf8',
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!out) return null;
    const name = normalizeShellName(out.split(/\s+/)[0] ?? '');
    return name || null;
  } catch {
    return null;
  }
}

export interface ShellInvocation {
  file: string;
  args: string[];
}

export function buildShellInvocation(command: string, shell: ShellInfo): ShellInvocation {
  switch (shell.kind) {
    case 'cmd':
      return { file: shell.path, args: ['/d', '/s', '/c', command] };
    case 'powershell':
      return {
        file: shell.path,
        args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
      };
    case 'posix':
    default:
      return { file: shell.path, args: ['-c', command] };
  }
}

export function prepareCommand(command: string, shell: ShellInfo): string {
  if (shell.platform !== 'win32') return command;
  if (shell.kind === 'cmd') return `chcp 65001>nul & ${command}`;
  if (shell.kind === 'powershell') {
    return `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ${command}`;
  }
  return command;
}

export function shellExecForm(shell: ShellInfo): string {
  switch (shell.kind) {
    case 'cmd':
      return `cmd.exe /d /s /c "<command>"`;
    case 'powershell':
      return `${shell.name} -NoLogo -NoProfile -NonInteractive -Command "<command>"`;
    case 'posix':
    default:
      return `${shell.name} -c "<command>"`;
  }
}
