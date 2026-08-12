import { defineConfig } from '@playwright/test'
import { phone } from './playwright.config.js'

// Tests against real pi, driven by a deterministic test extension instead of
// waiting on pi's own startup. Slower than the main suite, so they run on
// their own: `npm run test:smoke`. Each test gets a fresh server and pi (see
// tests/smoke/helpers.js) so no test inherits another's history — the session
// is the server, and this suite's whole job is history integrity. They send no
// prompts — the slash commands render fixture output without an agent turn —
// so no tokens.
export default defineConfig({
  testDir: 'tests/smoke',
  globalSetup: './tests/e2e/build.js',
  timeout: 90_000,
  expect: { timeout: 30_000 },
  workers: 1,
  reporter: 'list',
  use: { ...phone, baseURL: 'http://127.0.0.1:0' },
})
