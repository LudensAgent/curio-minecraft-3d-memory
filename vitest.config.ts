import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Other local checkouts can live below this repository; test only this package.
    // The acceptance/*.test.mjs harness uses node:test and is run separately.
    include: ['tests/**/*.test.ts'],
  },
});
