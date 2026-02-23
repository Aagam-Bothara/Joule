import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'bin/joule.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  external: ['@joule/core', '@joule/shared', '@joule/models', '@joule/tools', '@joule/server', '@joule/channels', 'commander', 'playwright', 'playwright-core'],
});
