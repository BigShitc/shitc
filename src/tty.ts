import { createInterface } from 'node:readline/promises';
import process from 'node:process';
import { InterruptedError } from './errors.js';

export function canPrompt(): boolean {
  return Boolean(process.stdin.isTTY);
}

export async function ask(question: string, defaultValue?: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  try {
    const suffix = defaultValue !== undefined && defaultValue !== '' ? ` [${defaultValue}]` : '';
    const answer = (await rl.question(`${question}${suffix}: `)).trim();
    return answer || defaultValue || '';
  } catch (err) {

    if (isAbortError(err)) throw new InterruptedError('input closed');
    throw err;
  } finally {
    rl.close();
  }
}

function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'AbortError' || (err as NodeJS.ErrnoException).code === 'ABORT_ERR' || /aborted/i.test(err.message);
}

export async function confirm(question: string, defaultYes = true): Promise<boolean> {
  const answer = (await ask(`${question} ${defaultYes ? '[Y/n]' : '[y/N]'}`)).trim().toLowerCase();
  if (!answer) return defaultYes;
  return answer === 'y' || answer === 'yes' || answer === '是' || answer === '好';
}

export function askSecret(question: string): Promise<string> {
  if (!process.stdin.isTTY) return ask(question);

  process.stderr.write(question);
  return new Promise<string>((resolve, reject) => {
    const stdin = process.stdin;
    const wasRaw = Boolean(stdin.isRaw);
    let value = '';
    let settled = false;

    const onEnd = (): void => finish(() => reject(new InterruptedError('input closed')));

    const cleanup = (): void => {
      stdin.removeListener('data', onData);
      stdin.removeListener('end', onEnd);
      stdin.removeListener('close', onEnd);
      try {
        stdin.setRawMode(wasRaw);
      } catch {

      }
      stdin.pause();
    };

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      process.stderr.write('\n');
      fn();
    };

    const onData = (chunk: Buffer | string): void => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      for (const ch of text) {
        if (ch === '\u0003') {
          finish(() => reject(new InterruptedError('interrupted')));
          return;
        }
        if (ch === '\r' || ch === '\n') {
          finish(() => resolve(value));
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          if (value.length > 0) {
            value = value.slice(0, -1);
            process.stderr.write('\b \b');
          }
          continue;
        }
        if (ch === '\u001b') continue; 
        if (ch >= ' ') {
          value += ch;
          process.stderr.write('*');
        }
      }
    };

    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
    stdin.on('end', onEnd);
    stdin.on('close', onEnd);
  });
}

export async function choose(question: string, options: string[], defaultIndex = 0): Promise<number> {
  const answer = await ask(question, String(defaultIndex + 1));
  const index = Number.parseInt(answer, 10);
  if (!Number.isFinite(index) || index < 1 || index > options.length) return defaultIndex;
  return index - 1;
}
