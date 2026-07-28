import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['lib/**/*.test.mjs', 'test/**/*.test.mjs'],
    // `testTimeout`, not `timeout` — the latter is not a vitest option, so it
    // sat inert and the suite ran on the 5s default. Rendering + SSIM for 7
    // slides exceeds that under parallel load.
    testTimeout: 180000,
    hookTimeout: 180000,
    reporter: 'verbose',
  },
});
