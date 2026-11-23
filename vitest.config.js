import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Unit tests cover one service at a time; tests/e2e/*.test.js drive the whole departure
    // line across every role. Playwright specs (tests/e2e/*.spec.js) are run separately by
    // `npm run test:browser` — vitest must not pick them up.
    include: ['tests/unit/**/*.test.js', 'tests/e2e/**/*.test.js'],
    environment: 'node',
  },
});
