import { defineConfig } from '@playwright/test'
import { phone } from './playwright.base.js'

export default defineConfig({
  testDir: 'e2e',
  timeout: 20_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? 'line' : 'list',
  use: { ...phone, baseURL: 'http://127.0.0.1:7690' },
  webServer: {
    command: 'node build.js && ttyd -W -p 7690 --index dist/client.html fixtures/fake-pi.sh',
    url: 'http://127.0.0.1:7690',
    reuseExistingServer: false,
    stdout: 'ignore',
  },
})
