import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:8081',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: process.env.CHROME_EXECUTABLE_PATH
      ? { executablePath: process.env.CHROME_EXECUTABLE_PATH }
      : {},
  },
  projects: [
    { name: 'mobile-web', use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 } } },
    { name: 'desktop-web', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } } },
  ],
  webServer: {
    command: process.env.E2E_PRODUCTION === '1'
      ? 'npm run serve:web -- --dir dist/app --port 8081'
      : 'npm run web -- --localhost --port 8081',
    url: 'http://127.0.0.1:8081',
    reuseExistingServer: !process.env.CI && process.env.E2E_PRODUCTION !== '1',
    timeout: 120_000,
    env: { CI: '1' },
  },
});
