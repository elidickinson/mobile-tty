import { defineConfig, devices } from '@playwright/test'

// WebKit at the measured device size — the same engine and geometry the phone
// runs, minus the keyboard.
export default defineConfig({
  testDir: 'e2e',
  timeout: 20_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? 'line' : 'list',
  use: {
    ...devices['Desktop Safari'],
    baseURL: 'http://127.0.0.1:7690',
    viewport: { width: 402, height: 812 },
    deviceScaleFactor: 3,
    hasTouch: true,
    isMobile: true,
  },
  webServer: {
    command: 'node build.js && ttyd -W -p 7690 --index dist/client.html fixtures/fake-pi.sh',
    url: 'http://127.0.0.1:7690',
    reuseExistingServer: false,
    stdout: 'ignore',
  },
})
