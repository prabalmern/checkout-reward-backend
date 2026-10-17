import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    pool: 'forks',
    fileParallelism: false,
    isolate: true,
    execArgv: ['--experimental-sqlite'],
  },
});
