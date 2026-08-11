import { defineConfig, devices } from '@playwright/test'

// Tests against real pi under dtach. Slower and mildly flakier than the main
// suite, so they run on their own: `npm run test:smoke`. They send no prompts,
// so they cost no tokens — they only check that pi still renders and reflows.
export default defineConfig({
  testDir: 'e2e-smoke',
  timeout: 90_000,
  expect: { timeout: 30_000 },
  workers: 1,
  reporter: 'list',
  use: {
    ...devices['Desktop Safari'],
    baseURL: 'http://127.0.0.1:7692',
    viewport: { width: 402, height: 812 },
    deviceScaleFactor: 3,
    hasTouch: true,
    isMobile: true,
  },
  webServer: {
    command: 'node build.js && ttyd -W -p 7692 --index dist/client.html dtach -A /tmp/mtty-smoke.sock -r winch -z pi',
    url: 'http://127.0.0.1:7692',
    reuseExistingServer: false,
    stdout: 'ignore',
  },
})
