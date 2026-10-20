import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InternalCompilerError, SourceError } from '../src/errors.js';
import {
  extractJsonObjects,
  normalizeRelPath,
  parsePlan,
  parsePlanDetailed,
  scanBalancedObjects,
  tryNormalizeRelPath,
} from '../src/parser.js';

function catchIce(fn: () => unknown): InternalCompilerError {
  try {
    fn();
  } catch (err) {
    if (err instanceof InternalCompilerError) return err;
    throw err;
  }
  throw new assert.AssertionError({ message: 'expected an InternalCompilerError' });
}

const VALID = {
  language: 'python',
  runtimeKind: 'interpreted',
  compileCommand: '',
  runCommand: 'python3 main.py',
  files: [{ path: 'main.py', content: 'print("helloword")\n' }],
  entry: 'main.py',
  notes: 'lowered prit to print',
};

describe('parsePlan: extraction', () => {
  it('parses a bare JSON envelope', () => {
    const plan = parsePlan(JSON.stringify(VALID));
    assert.equal(plan.language, 'python');
    assert.equal(plan.runtimeKind, 'interpreted');
    assert.equal(plan.compileCommand, '');
    assert.equal(plan.runCommand, 'python3 main.py');
    assert.deepEqual(plan.files, [{ path: 'main.py', content: 'print("helloword")\n' }]);
    assert.equal(plan.entry, 'main.py');
    assert.equal(plan.notes, 'lowered prit to print');
  });

  it('parses a fenced JSON block', () => {
    const raw = `Here you go:\n\n\`\`\`json\n${JSON.stringify(VALID, null, 2)}\n\`\`\`\n\nEnjoy.`;
    assert.equal(parsePlan(raw).language, 'python');
  });

  it('parses JSON embedded in prose without fences', () => {
    const raw = `Sure! The compiled program is ${JSON.stringify(VALID)} — done.`;
    assert.equal(parsePlan(raw).runCommand, 'python3 main.py');
  });

  it('tolerates trailing commas', () => {
    const raw = '{"language":"c","compileCommand":"gcc main.c -o main","runCommand":"./main","files":[{"path":"main.c","content":"int main(){return 0;}"}],"entry":"main.c",}';
    const plan = parsePlan(raw);
    assert.equal(plan.language, 'c');
    assert.equal(plan.runtimeKind, 'compiled');
  });

  it('unwraps { plan: ... } envelopes', () => {
    const plan = parsePlan(JSON.stringify({ plan: VALID }));
    assert.equal(plan.entry, 'main.py');
  });

  it('reports how each candidate was found', () => {
    assert.equal(extractJsonObjects(JSON.stringify(VALID))[0]?.via, 'direct');
    assert.equal(extractJsonObjects(`x\n\`\`\`json\n${JSON.stringify(VALID)}\n\`\`\``)[0]?.via, 'fence');
    assert.equal(extractJsonObjects(`prefix ${JSON.stringify(VALID)} suffix`)[0]?.via, 'scan');
  });

  it('ignores braces inside string literals when scanning', () => {
    const objects = scanBalancedObjects('prefix {"a": "} not a brace {", "b": {"c": 1}} suffix');
    assert.equal(objects.length, 1);
    assert.ok(objects[0]!.startsWith('{"a"'));
  });

  it('returns no candidates for plain prose', () => {
    assert.deepEqual(extractJsonObjects('I cannot compile this.'), []);
  });

  it('prefers the whole document over nested candidates', () => {
    const candidates = extractJsonObjects(JSON.stringify(VALID));
    assert.equal(candidates[0]?.text, JSON.stringify(VALID));
  });
});

describe('parsePlan: normalization', () => {
  it('infers compiled runtimeKind from a compile command', () => {
    const plan = parsePlan(
      JSON.stringify({
        language: 'c',
        compileCommand: 'gcc main.c -o main',
        runCommand: './main',
        files: [{ path: 'main.c', content: 'int main(void){return 0;}' }],
        entry: 'main.c',
      }),
    );
    assert.equal(plan.runtimeKind, 'compiled');
    assert.equal(plan.notes, '');
  });

  it('accepts files as an object map', () => {
    const plan = parsePlan(
      JSON.stringify({
        language: 'bash',
        runCommand: 'bash main.sh',
        files: { 'main.sh': 'echo hi\n' },
        entry: 'main.sh',
      }),
    );
    assert.deepEqual(plan.files, [{ path: 'main.sh', content: 'echo hi\n' }]);
    assert.equal(plan.runtimeKind, 'interpreted');
  });

  it('synthesizes a file from a bare code field', () => {
    const plan = parsePlan(JSON.stringify({ language: 'python', runCommand: 'python3 main.py', code: 'print(42)\n' }));
    assert.equal(plan.entry, 'main.py');
    assert.equal(plan.files[0]?.path, 'main.py');
  });

  it('falls back to the only file when entry is omitted', () => {
    const plan = parsePlan(
      JSON.stringify({ language: 'javascript', runCommand: 'node main.js', files: [{ path: 'main.js', content: 'console.log(1)\n' }] }),
    );
    assert.equal(plan.entry, 'main.js');
  });

  it('resolves an entry given as a basename', () => {
    const plan = parsePlan(
      JSON.stringify({
        language: 'rust',
        compileCommand: 'rustc src/main.rs -o main',
        runCommand: './main',
        files: [{ path: 'src/main.rs', content: 'fn main(){println!("hi");}\n' }],
        entry: 'main.rs',
      }),
    );
    assert.equal(plan.entry, 'src/main.rs');
  });

  it('normalizes ./ entry paths and strips a leading $ from commands', () => {
    const plan = parsePlan(
      JSON.stringify({
        language: 'python',
        runCommand: '  $ python3 main.py  ',
        files: [{ path: './main.py', content: 'print(1)\n' }],
        entry: './main.py',
      }),
    );
    assert.equal(plan.entry, 'main.py');
    assert.equal(plan.runCommand, 'python3 main.py');
  });

  it('infers language from the entry extension', () => {
    const plan = parsePlan(
      JSON.stringify({ runCommand: 'python3 main.py', files: [{ path: 'main.py', content: 'print(1)\n' }], entry: 'main.py' }),
    );
    assert.equal(plan.language, 'python');
  });

  it('reports the parse strategy', () => {
    const fenced = `\`\`\`json\n${JSON.stringify(VALID)}\n\`\`\``;
    assert.equal(parsePlanDetailed(fenced).stats.via, 'fence');
    assert.equal(parsePlanDetailed(JSON.stringify(VALID)).stats.via, 'direct');
  });
});

describe('parsePlan: rejection (ICE)', () => {
  it('rejects an empty response with ICE-003', () => {
    assert.equal(catchIce(() => parsePlan('   ')).code, 'ICE-003');
  });

  it('rejects prose without JSON with ICE-003', () => {
    const err = catchIce(() => parsePlan('I am sorry, I cannot help with that.'));
    assert.equal(err.code, 'ICE-003');
  });

  it('rejects malformed JSON with ICE-003', () => {
    assert.equal(catchIce(() => parsePlan('{"language": "python", broken')).code, 'ICE-003');
  });

  it('rejects a plan without runCommand with ICE-008', () => {
    const err = catchIce(() => parsePlan(JSON.stringify({ ...VALID, runCommand: '' })));
    assert.equal(err.code, 'ICE-008');
  });

  it('rejects a compiled declaration without compileCommand with ICE-008', () => {
    const err = catchIce(() =>
      parsePlan(JSON.stringify({ ...VALID, language: 'c', runtimeKind: 'compiled', compileCommand: '' })),
    );
    assert.equal(err.code, 'ICE-008');
  });

  it('rejects an empty program with ICE-005', () => {
    const err = catchIce(() => parsePlan(JSON.stringify({ language: 'python', runCommand: 'python3 main.py', files: [] })));
    assert.equal(err.code, 'ICE-005');
  });

  it('rejects path traversal with ICE-006', () => {
    const err = catchIce(() =>
      parsePlan(
        JSON.stringify({
          ...VALID,
          files: [{ path: '../../etc/evil.py', content: 'print(1)\n' }],
          entry: '../../etc/evil.py',
        }),
      ),
    );
    assert.equal(err.code, 'ICE-006');
  });

  it('rejects absolute paths with ICE-006', () => {
    const err = catchIce(() =>
      parsePlan(JSON.stringify({ ...VALID, files: [{ path: '/tmp/evil.py', content: 'print(1)\n' }], entry: '/tmp/evil.py' })),
    );
    assert.equal(err.code, 'ICE-006');
  });

  it('rejects Windows drive paths with ICE-006', () => {
    const err = catchIce(() =>
      parsePlan(JSON.stringify({ ...VALID, files: [{ path: 'C:\\evil.py', content: 'print(1)\n' }], entry: 'C:\\evil.py' })),
    );
    assert.equal(err.code, 'ICE-006');
  });

  it('rejects duplicate file paths with ICE-004', () => {
    const err = catchIce(() =>
      parsePlan(
        JSON.stringify({
          ...VALID,
          files: [
            { path: 'main.py', content: 'a\n' },
            { path: './main.py', content: 'b\n' },
          ],
        }),
      ),
    );
    assert.equal(err.code, 'ICE-004');
  });

  it('rejects an entry that matches no file when there are many', () => {
    const err = catchIce(() =>
      parsePlan(
        JSON.stringify({
          ...VALID,
          files: [
            { path: 'main.py', content: 'a\n' },
            { path: 'lib.py', content: 'b\n' },
          ],
          entry: 'other.py',
        }),
      ),
    );
    assert.equal(err.code, 'ICE-004');
  });

  it('rejects an empty file content with ICE-004', () => {
    const err = catchIce(() =>
      parsePlan(JSON.stringify({ ...VALID, files: [{ path: 'main.py', content: '   \n' }], entry: 'main.py' })),
    );
    assert.equal(err.code, 'ICE-004');
  });

  it('rejects destructive commands with ICE-012', () => {
    const err = catchIce(() =>
      parsePlan(JSON.stringify({ ...VALID, runCommand: 'rm -rf / --no-preserve-root' })),
    );
    assert.equal(err.code, 'ICE-012');
  });

  it('rejects commands that escape the working dir with ICE-012', () => {
    const err = catchIce(() => parsePlan(JSON.stringify({ ...VALID, runCommand: 'cat ../secret.txt' })));
    assert.equal(err.code, 'ICE-012');
  });

  it('allows a sandbox-local rm -rf of a build folder', () => {
    const plan = parsePlan(JSON.stringify({ ...VALID, runCommand: 'rm -rf build && python3 main.py' }));
    assert.equal(plan.runCommand, 'rm -rf build && python3 main.py');
  });
});

describe('path helpers', () => {
  it('normalizes separators and dot segments', () => {
    assert.equal(normalizeRelPath('src\\lib\\main.py'), 'src/lib/main.py');
    assert.equal(normalizeRelPath('./main.py'), 'main.py');
    assert.equal(normalizeRelPath('a//b/./c.txt'), 'a/b/c.txt');
  });

  it('returns null for unsafe paths', () => {
    for (const bad of ['/etc/passwd', '../x', 'a/../../b', 'C:\\x', '~/x', '   ', 'a/\u0000b']) {
      assert.equal(tryNormalizeRelPath(bad), null, `expected null for ${JSON.stringify(bad)}`);
    }
  });
});

describe('parsePlan: source rejection (syntax errors)', () => {
  const rejected = {
    status: 'invalid',
    diagnostics: [{ line: 2, message: 'expected a ShitLang program, found a request to write code' }],
    language: 'unknown',
    runtimeKind: 'interpreted',
    compileCommand: '',
    runCommand: '',
    files: [],
    entry: '',
    notes: '这不是一个程序。',
  };

  function catchSource(fn: () => unknown): SourceError {
    try {
      fn();
    } catch (err) {
      if (err instanceof SourceError) return err;
      throw err;
    }
    throw new assert.AssertionError({ message: 'expected a SourceError' });
  }

  it('throws SourceError (exit 65) for status:invalid', () => {
    const err = catchSource(() => parsePlan(JSON.stringify(rejected)));
    assert.equal(err.exitCode, 65);
    assert.equal(err.sourceLabel, '<source>');
    assert.equal(err.diagnostics.length, 1);
    assert.equal(err.diagnostics[0]?.line, 2);
    assert.match(err.diagnostics[0]?.message ?? '', /expected a ShitLang program/);
  });

  it('treats diagnostics without an explicit status as a rejection', () => {
    const err = catchSource(() => parsePlan(JSON.stringify({ ...rejected, status: undefined })));
    assert.equal(err.diagnostics[0]?.line, 2);
  });

  it('treats a diagnostics array on status:ok as a rejection', () => {
    const err = catchSource(() => parsePlan(JSON.stringify({ ...rejected, status: 'ok' })));
    assert.match(err.message, /expected a ShitLang program/);
  });

  it('normalizes string diagnostics and clamps bad line numbers', () => {
    const err = catchSource(() =>
      parsePlan(JSON.stringify({ ...rejected, diagnostics: ['this is not code', { line: 0, message: 'second' }] })),
    );
    assert.deepEqual(
      err.diagnostics.map((diagnostic) => [diagnostic.line, diagnostic.message]),
      [
        [1, 'this is not code'],
        [1, 'second'],
      ],
    );
  });

  it('falls back to a generic message when status:invalid has no diagnostics', () => {
    const err = catchSource(() =>
      parsePlan(
        JSON.stringify({
          ...rejected,
          diagnostics: [],
          notes: 'this is a request, not a program',
        }),
      ),
    );
    assert.match(err.message, /not a program/);
  });

  it('accepts a valid plan with status:ok and empty diagnostics', () => {
    const plan = parsePlan(JSON.stringify({ ...VALID, status: 'ok', diagnostics: [] }));
    assert.equal(plan.entry, 'main.py');
  });

  it('caps diagnostics at 20 entries', () => {
    const diagnostics = Array.from({ length: 30 }, (_, index) => ({ line: index + 1, message: `error ${index}` }));
    const err = catchSource(() => parsePlan(JSON.stringify({ ...rejected, diagnostics })));
    assert.equal(err.diagnostics.length, 20);
  });
});
