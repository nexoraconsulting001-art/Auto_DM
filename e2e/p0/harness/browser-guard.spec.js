// Proves the browser side of the gate: Chromium launches, axe runs, and pages can only reach this machine.
import http from 'node:http';
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const PAGE = '<!doctype html><html lang="en"><head><title>Harness</title></head><body><main><h1>Harness page</h1></main></body></html>';

test('a page loads from loopback, passes axe, and cannot reach an outside address', async ({ page }) => {
  const server = http.createServer((_req, res) => res.setHeader('content-type', 'text/html').end(PAGE));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await expect(page.locator('h1')).toHaveText('Harness page');
    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(violations).toEqual([]);
    // 192.0.2.1 is reserved for documentation and is never routed. Unguarded, this fetch would hang until the timeout.
    const outcome = await page.evaluate(() => Promise.race([
      fetch('http://192.0.2.1/', { mode: 'no-cors' }).then(() => 'reached', () => 'refused'),
      new Promise((resolve) => setTimeout(() => resolve('hung'), 5000)),
    ]));
    expect(outcome).toBe('refused');
  } finally {
    server.close();
  }
});
