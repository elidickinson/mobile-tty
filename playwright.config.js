import { defineConfig, devices } from '@playwright/test'

// WebKit at the measured device size — the same engine family the phone runs,
// minus the keyboard, the insets and touch. Shared with the smoke config.
export const phone = {
  ...devices['Desktop Safari'],
  viewport: { width: 402, height: 812 },
  deviceScaleFactor: 3,
  hasTouch: true,
  isMobile: true,
}

export default defineConfig({
  globalSetup: './tests/e2e/build.js',
  testDir: 'tests/e2e',
  timeout: 20_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? 'line' : 'list',
  use: phone,
})
