import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  external: ['@joule/core', '@joule/shared', 'hono', '@hono/node-server', '@hono/zod-validator'],
});
