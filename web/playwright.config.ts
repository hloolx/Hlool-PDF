import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 2,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    ...devices['Desktop Chrome'],
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  projects: [
    { name: 'browser', testIgnore: '**/*.offline.spec.ts', use: { baseURL: 'http://127.0.0.1:4173' } },
    { name: 'offline', testMatch: '**/*.offline.spec.ts', use: { baseURL: 'http://127.0.0.1:4174' } }
  ],
  webServer: [
    { command: 'npm run dev -- --port 4173 --strictPort', url: 'http://127.0.0.1:4173', env: { HLOOL_E2E: '1' }, reuseExistingServer: !process.env.CI },
    { command: 'npm run preview -- --host 127.0.0.1 --port 4174 --strictPort', url: 'http://127.0.0.1:4174', reuseExistingServer: !process.env.CI }
  ]
})
