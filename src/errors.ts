

export const EXIT = {
  OK: 0,
  COMPILE_FAILED: 65,
  USAGE: 64,
  INPUT: 66,
  ICE: 70,
  INTERRUPTED: 130,
} as const;

export const ICE = {
  CONFIG: 'ICE-001',
  REQUEST: 'ICE-002',
  RESPONSE: 'ICE-003',
  IR: 'ICE-004',
  EMPTY_PROGRAM: 'ICE-005',
  UNSAFE_PATH: 'ICE-006',
  WRITE: 'ICE-007',
  MISSING_COMMAND: 'ICE-008',
  EXEC: 'ICE-009',
  INVARIANT: 'ICE-010',
  UNEXPECTED: 'ICE-011',
  UNSAFE_COMMAND: 'ICE-012',
} as const;

export type IceCode = (typeof ICE)[keyof typeof ICE];

export const ICE_TITLES: Record<IceCode, string> = {
  'ICE-001': 'invalid compiler configuration',
  'ICE-002': 'model request failed',
  'ICE-003': 'unusable model response',
  'ICE-004': 'model response violates the ShitLang IR contract',
  'ICE-005': 'model produced no program',
  'ICE-006': 'unsafe output path in generated program',
  'ICE-007': 'failed to write generated files',
  'ICE-008': 'generated program is missing a required command',
  'ICE-009': 'failed to execute a stage',
  'ICE-010': 'internal invariant violated',
  'ICE-011': 'unexpected internal failure',
  'ICE-012': 'unsafe command in the generated program',
};

export interface ShitcErrorOptions {
  hint?: string;
  cause?: unknown;
}

export class ShitcError extends Error {
  readonly exitCode: number;
  readonly hint: string | undefined;

  constructor(message: string, exitCode: number, opts: ShitcErrorOptions = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = new.target.name;
    this.exitCode = exitCode;
    this.hint = opts.hint;
  }
}

export class UsageError extends ShitcError {
  constructor(message: string, opts: ShitcErrorOptions = {}) {
    super(message, EXIT.USAGE, opts);
  }
}

export class InputError extends ShitcError {
  constructor(message: string, opts: ShitcErrorOptions = {}) {
    super(message, EXIT.INPUT, opts);
  }
}

export interface SourceDiagnostic {
  line: number;
  message: string;
  hint?: string;
}

export class SourceError extends ShitcError {
  readonly sourceLabel: string;
  readonly diagnostics: SourceDiagnostic[];

  constructor(sourceLabel: string, diagnostics: SourceDiagnostic[], opts: ShitcErrorOptions = {}) {
    super(diagnostics[0]?.message ?? 'syntax error', EXIT.COMPILE_FAILED, opts);
    this.name = 'SourceError';
    this.sourceLabel = sourceLabel;
    this.diagnostics = diagnostics;
  }
}

export class InterruptedError extends ShitcError {
  constructor(message = 'interrupted', opts: ShitcErrorOptions = {}) {
    super(message, EXIT.INTERRUPTED, opts);
  }
}

export class InternalCompilerError extends ShitcError {
  readonly code: IceCode;
  readonly detail: string | undefined;

  constructor(code: IceCode, message: string, opts: ShitcErrorOptions & { detail?: string } = {}) {
    super(message, EXIT.ICE, opts);
    this.code = code;
    this.detail = opts.detail;
  }
}
