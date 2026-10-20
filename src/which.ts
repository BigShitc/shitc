import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';

const cache = new Map<string, string | null>();

export function findOnPath(command: string): string | null {
  const key = process.platform === 'win32' ? command.toLowerCase() : command;
  if (cache.has(key)) return cache.get(key) ?? null;
  const found = lookup(command);
  cache.set(key, found);
  return found;
}

export function hasCommand(command: string): boolean {
  return findOnPath(command) !== null;
}

export function clearPathCache(): void {
  cache.clear();
}

function lookup(command: string): string | null {
  if (!command) return null;

  if (command.includes('/') || command.includes('\\') || path.isAbsolute(command)) {
    return isExecutableFile(command) ? path.resolve(command) : null;
  }

  const pathEnv = process.env.PATH ?? process.env.Path ?? '';
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  const exts =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
          .split(';')
          .map((ext) => ext.trim())
          .filter(Boolean)
      : [''];

  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

function isExecutableFile(file: string): boolean {
  try {
    const stat = statSync(file);
    if (!stat.isFile()) return false;
    if (process.platform !== 'win32') {
      accessSync(file, constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}
