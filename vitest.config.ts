import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: [...configDefaults.exclude, '.claude/worktrees/**'],
    setupFiles: ['./tests/test-home-setup.ts'],
    // Because crypto-heavy peers delay short lifecycle timers.
    maxWorkers: 4,
    minWorkers: 1,
  },
});
