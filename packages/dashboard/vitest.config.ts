import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Cold TS-transform imports exceed the 5s default when the whole
    // workspace runs at once; this is transform cost, not test work.
    testTimeout: 30_000,
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    environment: 'jsdom',
  },
});
