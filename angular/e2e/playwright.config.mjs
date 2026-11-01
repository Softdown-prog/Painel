import { defineConfig } from '@playwright/test';

const origin = 'http://127.0.0.1:4175';
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.mjs',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['github'], ['line']] : 'list',
  use: {
    baseURL: origin,
    browserName: 'chromium',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    headless: true
  },
  webServer: {
    command: 'node serve.mjs',
    url: origin + '/angular/',
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
    env: { NODE_ENV: 'test' }
  },
  outputDir: 'test-results'
});
