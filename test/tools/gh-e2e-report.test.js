// tools/gh-e2e-report.mjs: the Playwright JSON report -> the "Browser test errors (full)" section, and the zip reader.
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { PER_TEST_CAP, renderE2eErrors, unzip } from '../../tools/gh-e2e-report.mjs';

const ESC = String.fromCharCode(27);
const axe = `Expected: []\nReceived: [{"id":"color-contrast","nodes":[{"target":["#save > span"]}]}]`;
const report = {
  config: { rootDir: '/x' },
  suites: [
    {
      title: 'e2e/p0/a.spec.js',
      file: 'e2e/p0/a.spec.js',
      specs: [
        { title: 'passes', file: 'e2e/p0/a.spec.js', tests: [{ projectName: 'phone', status: 'expected', results: [{ status: 'passed', errors: [] }] }] },
      ],
      suites: [
        {
          title: 'Settings page',
          file: 'e2e/p0/a.spec.js',
          specs: [
            { title: 'has no axe violations', file: 'e2e/p0/a.spec.js', tests: [{ projectName: 'phone', status: 'unexpected', results: [{ status: 'failed', errors: [{ message: `${ESC}[31m${axe}${ESC}[39m` }] }] }] },
            { title: 'is flaky', file: 'e2e/p0/a.spec.js', tests: [{ projectName: 'phone', status: 'flaky', results: [{ errors: [{ message: 'x' }] }] }] },
            { title: 'huge', file: 'e2e/p0/a.spec.js', tests: [{ projectName: 'phone', status: 'timedOut', results: [{ errors: [{ message: 'y'.repeat(5000) }] }] }] },
          ],
        },
      ],
    },
  ],
};

test('failing tests are listed with file, title and the full error; passing and flaky ones are not', async () => {
  const md = renderE2eErrors([report]);
  assert.match(md, /^## Browser test errors \(full\)/);
  assert.match(md, /`e2e\/p0\/a\.spec\.js` \[phone\] Settings page › has no axe violations/);
  assert.ok(md.includes('"id":"color-contrast"') && md.includes('#save > span'));
  assert.ok(!md.includes(ESC));
  assert.ok(!md.includes('passes') && !md.includes('is flaky'));
  const huge = md.split('### ').find((s) => s.includes('huge'));
  assert.ok(huge.includes('y'.repeat(PER_TEST_CAP - 1) + '…') && !huge.includes('y'.repeat(PER_TEST_CAP + 1)));
});

test('no failures gives no section', async () => {
  assert.equal(renderE2eErrors([{ suites: [] }]), '');
});

test('unzip reads stored and deflated entries', async () => {
  const entry = (name, data, method) => ({ name: Buffer.from(name), method, comp: method === 8 ? zlib.deflateRawSync(data) : data, size: data.length });
  const entries = [entry('a.json', Buffer.from('{"a":1}'), 0), entry('b.json', Buffer.from('{"b":"' + 'z'.repeat(100) + '"}'), 8)];
  const parts = [];
  const dir = [];
  let offset = 0;
  for (const e of entries) {
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(e.method, 8);
    head.writeUInt32LE(e.comp.length, 18);
    head.writeUInt32LE(e.size, 22);
    head.writeUInt16LE(e.name.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(e.method, 10);
    cen.writeUInt32LE(e.comp.length, 20);
    cen.writeUInt32LE(e.size, 24);
    cen.writeUInt16LE(e.name.length, 28);
    cen.writeUInt32LE(offset, 42);
    dir.push(cen, e.name);
    parts.push(head, e.name, e.comp);
    offset += 30 + e.name.length + e.comp.length;
  }
  const central = Buffer.concat(dir);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  const files = unzip(Buffer.concat([...parts, central, end]));
  assert.deepEqual(JSON.parse(files['a.json']), { a: 1 });
  assert.equal(JSON.parse(files['b.json']).b.length, 100);
});
