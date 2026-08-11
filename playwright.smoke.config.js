import { defineConfig } from '@playwright/test'
import { phone } from './playwright.config.js'

// Tests against real pi under dtach. Slower and mildly flakier than the main
// suite, so they run on their own: `npm run test:smoke`. They send no prompts,
// so they cost no tokens — they only check that pi still renders and reflows.
export default defineConfig({
  testDir: 'tests/smoke',
  timeout: 90_000,
  expect: { timeout: 30_000 },
  workers: 1,
  reporter: 'list',
  use: { ...phone, baseURL: 'http://127.0.0.1:7692' },
  webServer: {
    command: 'node scripts/build.js && ttyd -W -p 7692 --index dist/client.html dtach -A /tmp/mtty-smoke.sock -r winch -z pi',
    url: 'http://127.0.0.1:7692',
    reuseExistingServer: false,
    stdout: 'ignore',
  },
})
