import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./.snippets', import.meta.url)) },
  },
  test: {
    globals: true,
    environment: 'node',
    restoreMocks: true,
    mockReset: true,
    unstubEnvs: true,
    coverage: {
      provider: 'v8',
      include: ['.snippets/**/*.{ts,tsx}'],
      reporter: ['text', 'html', 'lcov'],
      thresholds: { lines: 95, functions: 95, branches: 90, statements: 95 },
    },
  },
});
