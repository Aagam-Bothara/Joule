import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'benchmarks',
    include: ['tests/**/*.test.ts'],
  },
});
