import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { PROGRAM, VERSION } from '../src/version.js';
import { PROJECT_ROOT } from './helpers.js';

describe('package identity', () => {
  const pkg = JSON.parse(readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8')) as {
    name: string;
    version: string;
    bin: Record<string, string>;
    type: string;
    engines: { node: string };
  };

  it('keeps src/version.ts in sync with package.json', () => {
    assert.equal(PROGRAM, pkg.name);
    assert.equal(VERSION, pkg.version);
  });

  it('exposes a global bin named shitc', () => {
    assert.equal(pkg.bin[PROGRAM], 'dist/cli.js');
    assert.equal(pkg.type, 'module');
  });

  it('declares a supported node range', () => {
    assert.match(pkg.engines.node, />=\s*20/);
  });
});
