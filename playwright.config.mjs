// Browser tests for the gate: e2e/pN/** and e2e/attack/pN/**. Phone-sized first, and no retries: a flaky test is a failing test.
import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { findHome } from './tools/gate-lib.mjs';

// Browsers live beside the repo here, so every worktree shares one download.
const browsers = path.join(findHome(), '.cache', 'ms-playwright');
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync(browsers)) process.env.PLAYWRIGHT_BROWSERS_PATH = browsers;

export default defineConfig({
  testDir: 'e2e',
  testMatch: /\.(spec|test)\.m?js$/,
  outputDir: 'test-results',
  forbidOnly: true,
  retries: 0,
  workers: 2,
  timeout: 60_000,
  projects: [
    {
      name: 'phone',
      use: {
        ...devices['Pixel 7'],
        // The browser is not covered by net-guard. Chromium always skips the proxy for loopback, and this
        // dead proxy swallows everything else, so a page can never reach a real service.
        launchOptions: { args: ['--proxy-server=http://127.0.0.1:9'] },
      },
    },
  ],
});
