import { findOnPath } from './which.js';

export interface ToolchainEntry {
  label: string;
  commands: string[];
}

export interface Toolchain {
  label: string;

  command: string;
  path: string;
}

const CATALOG: ToolchainEntry[] = [
  { label: 'JavaScript/TypeScript via Node.js', commands: ['node'] },
  { label: 'TypeScript/JavaScript via Deno', commands: ['deno'] },
  { label: 'TypeScript/JavaScript via Bun', commands: ['bun'] },
  { label: 'Python', commands: ['python3', 'python'] },
  { label: 'Go', commands: ['go'] },
  { label: 'Rust', commands: ['rustc', 'cargo'] },
  { label: 'C via gcc', commands: ['gcc'] },
  { label: 'C++ via g++', commands: ['g++'] },
  { label: 'C/C++ via clang', commands: ['clang', 'clang++'] },
  { label: 'Java', commands: ['javac', 'java'] },
  { label: 'C# via .NET', commands: ['dotnet'] },
  { label: 'Ruby', commands: ['ruby'] },
  { label: 'PHP', commands: ['php'] },
  { label: 'Perl', commands: ['perl'] },
  { label: 'Lua', commands: ['lua', 'luajit'] },
  { label: 'Swift', commands: ['swift', 'swiftc'] },
  { label: 'Zig', commands: ['zig'] },
  { label: 'Dart', commands: ['dart'] },
  { label: 'Julia', commands: ['julia'] },
  { label: 'R', commands: ['Rscript'] },
  { label: 'Elixir', commands: ['elixir'] },
  { label: 'Haskell via GHC', commands: ['ghc'] },
  { label: 'Nim', commands: ['nim'] },
  { label: 'Kotlin', commands: ['kotlinc'] },
  { label: 'Scala', commands: ['scala', 'scalac'] },
  { label: 'Fortran via gfortran', commands: ['gfortran'] },
  { label: 'COBOL via GnuCOBOL', commands: ['cobc'] },
  { label: 'COBOL via GCC gcobol', commands: ['gcobc', 'gcobol'] },
  { label: 'make', commands: ['make'] },
  { label: 'CMake', commands: ['cmake'] },
  { label: 'POSIX shell', commands: ['sh'] },
  { label: 'Bash', commands: ['bash'] },
  { label: 'awk', commands: ['awk'] },
];

export function detectToolchains(): Toolchain[] {
  const found: Toolchain[] = [];
  for (const entry of CATALOG) {
    for (const command of entry.commands) {
      const resolved = findOnPath(command);
      if (resolved) {
        found.push({ label: entry.label, command, path: resolved });
        break;
      }
    }
  }
  return found;
}

export function formatToolchains(toolchains: Toolchain[]): string {
  return toolchains.map((tool) => `${tool.command} (${tool.label.replace(/ via .*/, '')})`).join(', ');
}
