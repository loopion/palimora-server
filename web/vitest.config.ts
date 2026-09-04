import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    // scripts/prerender.smoke.test.mjs is a plain node:test file (it needs
    // to run after a real build, against the built dist/ output) — exclude
    // it here so Vitest's default *.test.mjs glob doesn't also try to run
    // it as a Vitest suite.
    exclude: ['**/node_modules/**', 'scripts/**'],
  },
})
