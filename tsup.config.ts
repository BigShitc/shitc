import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { cli: 'src/cli.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  clean: true,
  dts: false,
  sourcemap: true,
  splitting: false,
  shims: false,

  esbuildOptions(options) {
    options.legalComments = 'none';
  },
});
