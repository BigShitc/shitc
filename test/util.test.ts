import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  artifactId,
  estimateTokens,
  expandHome,
  formatBytes,
  formatDuration,
  isLoopbackUrl,
  maskSecret,
  oneLine,
  stripAnsi,
  toPosixPath,
  truncate,
} from '../src/util.js';

describe('formatting helpers', () => {
  it('formats durations', () => {
    assert.equal(formatDuration(0), '0ms');
    assert.equal(formatDuration(840), '840ms');
    assert.equal(formatDuration(8400), '8.4s');
    assert.equal(formatDuration(65_000), '1m05s');
    assert.equal(formatDuration(Number.NaN), '0ms');
  });

  it('formats byte counts', () => {
    assert.equal(formatBytes(12), '12 B');
    assert.equal(formatBytes(2048), '2.0 KiB');
    assert.equal(formatBytes(3 * 1024 * 1024), '3.0 MiB');
  });

  it('truncates and flattens text', () => {
    assert.equal(truncate('abcdef', 4), 'abc…');
    assert.equal(truncate('abc', 10), 'abc');
    assert.equal(oneLine('a\n b\t c'), 'a b c');
  });

  it('strips ANSI color codes', () => {
    assert.equal(stripAnsi('\u001b[32mok\u001b[39m'), 'ok');
    assert.equal(stripAnsi('plain'), 'plain');
  });
});

describe('secrets', () => {
  it('masks api keys without leaking them', () => {
    assert.equal(maskSecret(''), '(unset)');
    assert.equal(maskSecret('short'), 's****');
    const masked = maskSecret('sk-1234567890abcdef');
    assert.match(masked, /^sk-…cdef$/);
    assert.doesNotMatch(masked, /1234567890/);
  });
});

describe('urls and paths', () => {
  it('recognizes loopback endpoints', () => {
    for (const url of ['http://localhost:11434/v1', 'http://127.0.0.1:1234/v1', 'http://[::1]:8080', 'http://0.0.0.0:9000']) {
      assert.equal(isLoopbackUrl(url), true, url);
    }
    for (const url of ['https://api.openai.com/v1', 'http://192.168.1.10:8080', 'not a url']) {
      assert.equal(isLoopbackUrl(url), false, url);
    }
  });

  it('expands home-relative paths', () => {
    assert.equal(expandHome('~'), homedir());
    assert.equal(expandHome('~/x'), path.join(homedir(), 'x'));
    assert.equal(expandHome('/abs/x'), '/abs/x');
  });

  it('normalizes separators to posix', () => {
    assert.equal(toPosixPath('a\\b\\c'), 'a/b/c');
  });
});

describe('artifacts', () => {
  it('generates sortable, unique build ids', () => {
    const first = artifactId(new Date(2025, 0, 2, 3, 4, 5));
    assert.match(first, /^20250102-030405-[0-9a-f]{4}$/);

    const ids = new Set(Array.from({ length: 50 }, () => artifactId()));
    assert.equal(ids.size, 50, 'build ids should be unique');
  });

  it('estimates tokens from characters', () => {
    assert.ok(estimateTokens(400) >= 100);
    assert.equal(estimateTokens(0), 1);
  });
});
