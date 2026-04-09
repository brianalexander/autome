import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environmentMatchGlobs: [
      ['frontend/**/*.test.{ts,tsx}', 'jsdom'],
    ],
    setupFiles: ['./frontend/src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'html'],
      reportsDirectory: './coverage',
      include: [
        'src/**/*.ts',
        'frontend/src/**/*.ts',
        'frontend/src/**/*.tsx',
      ],
      exclude: [
        '**/__tests__/**',
        '**/*.test.ts',
        '**/*.test.tsx',
        '**/node_modules/**',
        'src/db/migrations/**',
        'dist/**',
        'packages/**',  // ACP package has its own tests
      ],
    },
  },
});
