import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['lib/**/*.test.mjs', 'test/**/*.test.mjs'],
    timeout: 180000, // rendering + SSIM for 7 slides takes a while
    reporter: 'verbose',
  },
});
