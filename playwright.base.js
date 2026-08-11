import { devices } from '@playwright/test'

// WebKit at the measured device size — the same engine and geometry the phone
// runs, minus the keyboard and the safe-area insets.
export const phone = {
  ...devices['Desktop Safari'],
  viewport: { width: 402, height: 812 },
  deviceScaleFactor: 3,
  hasTouch: true,
  isMobile: true,
}
