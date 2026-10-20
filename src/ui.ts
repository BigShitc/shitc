import { formatDuration, truncate } from './util.js';

const NO_COLOR = 'NO_COLOR' in process.env || process.env.TERM === 'dumb';
const FORCE_COLOR = (process.env.FORCE_COLOR ?? '').trim();
const COLOR =
  !NO_COLOR && (FORCE_COLOR !== '' ? FORCE_COLOR !== '0' : Boolean(process.stdout.isTTY) && !isDumbTerminal());

function isDumbTerminal(): boolean {
  if (process.platform === 'win32') {
    return Boolean(process.env.TERM) && process.env.TERM === 'dumb';
  }
  return false;
}

const UNICODE =
  process.platform !== 'win32' ||
  Boolean(process.env.WT_SESSION) ||
  Boolean(process.env.ConEmuANSI) ||
  process.env.TERM_PROGRAM === 'vscode';

function paint(open: string, close: string): (text: string) => string {
  return (text: string) => (COLOR ? `\u001b[${open}m${text}\u001b[${close}m` : text);
}

export const color = {
  bold: paint('1', '22'),
  dim: paint('2', '22'),
  red: paint('31', '39'),
  green: paint('32', '39'),
  yellow: paint('33', '39'),
  blue: paint('34', '39'),
  magenta: paint('35', '39'),
  cyan: paint('36', '39'),
  gray: paint('90', '39'),
};

export const symbol = {
  ok: UNICODE ? '✔' : 'OK',
  fail: UNICODE ? '✖' : 'x',
  warn: UNICODE ? '!' : '!',
  arrow: UNICODE ? '›' : '>',
  bullet: UNICODE ? '·' : '-',
  dot: UNICODE ? '•' : '*',
  prompt: UNICODE ? '❯' : '$',
  spinner: UNICODE ? ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] : ['-', '\\', '|', '/'],
};

export interface UiOptions {
  json?: boolean;
  quiet?: boolean;
  verbose?: boolean;

  log?: boolean;
}

export interface StepHandle {

  update(suffix: string): void;

  done(label?: string): void;

  fail(label?: string): void;
}

const SPINNER_INTERVAL_MS = 80;

class Spinner {
  private timer: NodeJS.Timeout | null = null;
  private frame = 0;
  private startedAt = Date.now();
  private suffix = '';
  private label: string;
  private readonly enabled: boolean;

  constructor(label: string, enabled: boolean) {
    this.label = label;
    this.enabled = enabled;
  }

  start(): void {
    if (!this.enabled) return;
    this.startedAt = Date.now();
    this.render();
    this.timer = setInterval(() => this.render(), SPINNER_INTERVAL_MS);
    this.timer.unref?.();
  }

  setLabel(label: string): void {
    this.label = label;
    if (this.enabled) this.render();
  }

  setSuffix(suffix: string): void {
    this.suffix = suffix;
    if (this.enabled) this.render();
  }

  private render(): void {
    const elapsed = formatDuration(Date.now() - this.startedAt);
    const frames = symbol.spinner;
    const glyph = frames[this.frame % frames.length] ?? '-';
    this.frame += 1;
    const suffix = this.suffix ? ` ${color.dim(`${symbol.bullet} ${this.suffix}`)}` : '';
    process.stderr.write(`\r\u001b[2K${color.cyan(glyph)} ${this.label} ${color.dim(elapsed)}${suffix}`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.enabled) process.stderr.write('\r\u001b[2K');
  }
}

export class Ui {
  readonly json: boolean;
  readonly quiet: boolean;
  readonly verbose: boolean;
  readonly logEnabled: boolean;
  private readonly startedAt = Date.now();

  constructor(options: UiOptions = {}) {
    this.json = options.json ?? false;
    this.quiet = options.quiet ?? false;
    this.verbose = options.verbose ?? false;
    this.logEnabled = options.log ?? false;
  }

  get machine(): boolean {
    return this.json || this.quiet;
  }

  private get chrome(): boolean {
    return this.logEnabled && !this.json;
  }

  banner(lines: string[]): void {
    if (!this.chrome) return;
    for (const line of lines) process.stderr.write(`${color.dim(line)}\n`);
  }

  detail(label: string, value: string): void {
    if (!this.chrome) return;
    process.stderr.write(`  ${color.dim(label.padEnd(8))} ${value}\n`);
  }

  step(label: string): StepHandle {

    const spinner = new Spinner(label, process.stderr.isTTY === true && !this.machine);
    spinner.start();
    const startedAt = Date.now();

    const finish = (glyph: string, tint: (text: string) => string, fallbackLabel: string, custom?: string): void => {
      spinner.stop();
      if (!this.chrome) return;
      const text = custom ?? fallbackLabel;
      const elapsed = formatDuration(Date.now() - startedAt);
      process.stderr.write(`${tint(glyph)} ${text} ${color.dim(`${symbol.bullet} ${elapsed}`)}\n`);
    };

    return {
      update: (suffix: string) => spinner.setSuffix(suffix),
      done: (custom?: string) => finish(symbol.ok, color.green, label, custom),
      fail: (custom?: string) => finish(symbol.fail, color.red, label, custom),
    };
  }

  stageCommand(command: string): void {
    if (!this.chrome) return;
    process.stderr.write(`${color.dim(`$ ${truncate(command, 300)}`)}\n`);
  }

  stageResult(name: 'compile' | 'run', ok: boolean, exitCode: number | null, durationMs: number, timedOut: boolean): void {
    if (!this.chrome || !ok) return;
    const elapsed = formatDuration(durationMs);
    if (name === 'compile') process.stderr.write(`${color.green(symbol.ok)} built ${color.dim(`${symbol.bullet} ${elapsed}`)}\n`);
  }

  note(message: string): void {
    if (!this.chrome) return;
    process.stderr.write(`${color.dim(message)}\n`);
  }

  status(message: string): void {
    if (this.json) return;
    process.stderr.write(`${color.dim(message)}\n`);
  }

  warn(message: string): void {
    process.stderr.write(`${color.yellow(symbol.warn)} ${message}\n`);
  }

  error(message: string): void {
    process.stderr.write(`${color.red(`${symbol.fail} ${message}`)}\n`);
  }

  fileBlock(path: string, content: string): void {
    if (this.machine) return;
    const rule = '─'.repeat(Math.max(6, 44 - path.length));
    process.stderr.write(`\n${color.dim('──')} ${color.cyan(path)} ${color.dim(rule)}\n`);
    for (const line of content.replace(/\r?\n$/, '').split(/\r?\n/)) {
      process.stderr.write(`  ${line}\n`);
    }
  }

  outputBlock(output: string): void {
    if (!output) return;
    for (const line of output.split(/\r?\n/)) {
      process.stderr.write(`  ${line}\n`);
    }
  }

  log(event: string, message: string): void {
    if (!this.logEnabled) return;
    const elapsed = ((Date.now() - this.startedAt) / 1000).toFixed(3).padStart(7, '0');
    process.stderr.write(`${color.dim(`[shitc ${elapsed}s]`)} ${color.cyan(event.padEnd(9))} ${message}\n`);
  }

  verboseLog(message: string, detail?: string): void {
    if (!this.verbose) return;
    process.stderr.write(`${color.gray(`[verbose] ${message}`)}\n`);
    if (detail) {
      for (const line of detail.split(/\r?\n/)) process.stderr.write(`${color.gray(`[verbose] ${line}`)}\n`);
    }
  }
}
