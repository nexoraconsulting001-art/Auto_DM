import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NoTenantError } from '../../../src/tenancy.js';
import { bindTenant } from '../../../src/repos/index.js';
import { brandCss, brandFontsHref, contrastRatio } from '../../../src/modules/brand/theme.js';
import { REEL_ID, seedReel, setup, startApp } from '../../helpers.js';
import { at, dbAtMigration } from './support.js';

async function twoBusinesses() {
  const { platform, repos: a } = await setup();
  const other = await platform.tenants.create({ slug: 'leaf', name: 'Leaf' });
  return { platform, a, b: bindTenant(platform, other) };
}

test('a business that never saved a kit gets the default preset, with nothing left empty', async () => {
  const { repos } = await setup();
  const kit = await repos.brandKit.get();
  assert.equal(kit.preset, 'utsav');
  assert.equal(kit.presetName, 'Utsav');
  assert.equal(kit.headingFont, 'Cormorant Garamond');
  assert.equal(kit.bodyFont, 'Jost');
  assert.equal(kit.logoUrl, '');
  for (const key of ['ground', 'card', 'ink', 'muted', 'line', 'primary', 'on_primary', 'accent', 'on_accent', 'eyebrow']) {
    assert.match(kit.colors[key], /^#[0-9A-F]{6}$/, key);
  }
});

test('the five presets exist and each passes 4.5:1', async () => {
  const { repos } = await setup();
  const presets = await repos.brandKit.presets();
  assert.deepEqual(presets.map((p) => p.name), ['Utsav', 'Dewdrop', 'Tadka', 'Gadget Galli', 'Mitti']);
  for (const p of presets) {
    assert.ok(contrastRatio(p.colors.primary, p.colors.on_primary) >= 4.5, p.name);
    assert.ok(contrastRatio(p.colors.ink, p.colors.ground) >= 4.5, p.name);
    assert.ok(brandFontsHref({ headingFont: p.heading_font, bodyFont: p.body_font }).includes(p.heading_font.replace(/ /g, '+')), p.name);
  }
});

test('a kit needs a current business', async () => {
  const { platform } = await setup();
  await assert.rejects(() => platform.brandKit.get(), NoTenantError);
  await assert.rejects(() => platform.brandKit.save({ preset: 'tadka' }), NoTenantError);
});

test('each business has its own kit', async () => {
  const { a, b } = await twoBusinesses();
  await a.brandKit.save({ preset: 'tadka', logoUrl: 'https://cdn.example/a.png', colors: { primary: '#234D33' } });
  assert.equal((await a.brandKit.get()).preset, 'tadka');
  const other = await b.brandKit.get();
  assert.equal(other.preset, 'utsav');
  assert.equal(other.logoUrl, '');
  assert.notEqual(other.colors.primary, '#234D33');
});

test('saving keeps fields left out, and clears a colour set to empty', async () => {
  const { repos } = await setup();
  await repos.brandKit.save({ logoUrl: 'https://cdn.example/a.png', colors: { primary: '#234d33' }, headingFont: 'Playfair Display' });
  const saved = await repos.brandKit.save({ bodyFont: 'Inter' });
  assert.equal(saved.logoUrl, 'https://cdn.example/a.png');
  assert.equal(saved.colors.primary, '#234D33', 'stored upper case');
  assert.equal(saved.headingFont, 'Playfair Display');
  assert.equal(saved.bodyFont, 'Inter');
  const cleared = await repos.brandKit.save({ colors: { primary: '' }, logoUrl: '' });
  assert.equal(cleared.colors.primary, '#7A1F3D', 'back to the preset');
  assert.equal(cleared.logoUrl, '');
});

test('switching preset starts from the new preset, and logos stay', async () => {
  const { repos } = await setup();
  await repos.brandKit.save({ preset: 'tadka', logoUrl: 'https://cdn.example/a.png', colors: { primary: '#234D33' }, headingFont: 'Playfair Display' });
  const mitti = await repos.brandKit.save({ preset: 'mitti' });
  assert.equal(mitti.preset, 'mitti');
  assert.equal(mitti.colors.primary, '#4E5D3A');
  assert.equal(mitti.headingFont, 'Lora');
  assert.equal(mitti.logoUrl, 'https://cdn.example/a.png');
});

test('F-12: primary and on_primary at 2:1 contrast are blocked, naming both fields', async () => {
  const { repos } = await setup();
  await assert.rejects(
    () => repos.brandKit.save({ colors: { primary: '#808080', on_primary: '#404040' } }),
    (err) => /primary/.test(err.message) && /on_primary/.test(err.message),
  );
  assert.equal((await repos.brandKit.get()).colors.primary, '#7A1F3D', 'nothing was saved');
});

test('bad kit values are refused', async () => {
  const { repos } = await setup();
  const refuses = (input, pattern) => assert.rejects(() => repos.brandKit.save(input), pattern);
  await refuses({ preset: 'no-such-theme' }, /no theme/);
  await refuses({ colors: { primary: 'red' } }, /primary must be a colour/);
  await refuses({ colors: { primary: '#12345' } }, /primary must be a colour/);
  await refuses({ colors: { primary: '#ffffff;}body{display:none' } }, /primary must be a colour/);
  await refuses({ colors: { nonsense: '#ffffff' } }, /Unknown colour/);
  await refuses({ headingFont: 'Comic Sans MS' }, /isn’t available/);
  await refuses({ bodyFont: "x'}</style><script>" }, /isn’t available/);
  await refuses({ bodyFont: '__proto__' }, /isn’t available/);
  await refuses({ logoUrl: 'javascript:alert(1)' }, /must be a web link/);
  await refuses({ faviconUrl: 'data:text/html,x' }, /must be a web link/);
});

test('nothing unsafe reaches the style tag, even from a bad row', () => {
  const css = brandCss({
    colors: { ink: 'red}</style><script>alert(1)</script>', ground: '#ffffff', primary: '#000000' },
    headingFont: "x'}</style><script>",
    bodyFont: '__proto__',
  });
  assert.doesNotMatch(css, /script|<\//);
});

test('F-07: a business\'s own domain serves its store with its brand kit', async () => {
  const app = await startApp();
  try {
    const other = await app.platform.tenants.create({ slug: 'leaf', name: 'Leaf' });
    await app.platform.tenants.addDomain(other.id, 'shop.leaf.example');
    const leaf = bindTenant(app.platform, other);
    await leaf.settings.update({ store_name: 'Leaf and Clay' });
    await leaf.brandKit.save({ logoUrl: 'https://cdn.example/leaf.png', faviconUrl: 'https://cdn.example/fav.png', colors: { primary: '#234D33' }, headingFont: 'Playfair Display' });

    const page = await (await fetch(`${app.base}/`, { headers: at('shop.leaf.example') })).text();
    assert.match(page, /Leaf and Clay/);
    assert.match(page, /--gold:#234D33/);
    assert.match(page, /--display:'Playfair Display'/);
    assert.match(page, /family=Playfair\+Display/);
    assert.match(page, /<img src="https:\/\/cdn\.example\/leaf\.png"/);
    assert.match(page, /rel="icon" href="https:\/\/cdn\.example\/fav\.png"/);

    const mine = await (await fetch(`${app.base}/`)).text();
    assert.doesNotMatch(mine, /234D33|leaf\.png/);
  } finally {
    app.close();
  }
});

test('every buyer page reads the kit, and a preset switch changes it at once', async () => {
  const app = await startApp();
  try {
    const { products } = await seedReel(app.repos, { n: 1 });
    const pages = ['/', '/shop', '/reels', '/about', '/login', '/signup', `/p/${products[0].slug}`, '/r/brunch-edit', '/no-such-page'];
    await app.repos.brandKit.save({ preset: 'tadka' });
    for (const path of pages) assert.match(await (await fetch(`${app.base}${path}`)).text(), /--gold:#B4340F/, path);
    await app.repos.brandKit.save({ preset: 'gadget-galli' });
    const dark = await (await fetch(`${app.base}/`)).text();
    assert.match(dark, /--gold:#3D62F2/);
    assert.match(dark, /color-scheme:dark/);
    assert.ok(REEL_ID);
  } finally {
    app.close();
  }
});

test('buyer pages never name the platform', async () => {
  const app = await startApp();
  try {
    const { products } = await seedReel(app.repos, { n: 1 });
    for (const path of ['/', '/shop', '/login', `/p/${products[0].slug}`, '/r/brunch-edit']) {
      assert.doesNotMatch(await (await fetch(`${app.base}${path}`)).text(), /bhava/i, path);
    }
  } finally {
    app.close();
  }
});

test('the console still sets the logo and accent, now in the kit', async () => {
  const { login } = await import('../../helpers.js');
  const { withConsoleApi } = await import('../console-port/support/console-api.js');
  const app = await startApp({ modules: withConsoleApi() });
  try {
    const { cookie, csrf } = await login(app.base);
    const res = await fetch(`${app.base}/api/v1/brand-kit`, {
      method: 'PATCH', headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, redirect: 'manual',
      body: JSON.stringify({ logoUrl: 'https://cdn.example/k.png', colors: { accent: '#112233' } }),
    });
    assert.equal(res.status, 200);
    const kit = await app.repos.brandKit.get();
    assert.equal(kit.logoUrl, 'https://cdn.example/k.png');
    assert.equal(kit.colors.accent, '#112233');
    assert.equal((await (await fetch(`${app.base}/api/v1/brand-kit`, { headers: { cookie } })).json()).colors.accent, '#112233');
  } finally {
    app.close();
  }
});

test('the migration moves an existing logo and accent into the kit', async () => {
  const { db, finish } = await dbAtMigration('002');
  const [t] = await db.query(`INSERT INTO tenants (slug, name) VALUES ('old', 'Old') RETURNING id`);
  await db.query(`INSERT INTO settings (tenant_id, key, value) VALUES ($1, 'logo_url', 'https://cdn.example/o.png'), ($1, 'accent_color', '#123456'), ($1, 'tagline', 'Keep me')`, [t.id]);
  await finish();
  const [kit] = await db.query('SELECT * FROM brand_kits WHERE tenant_id = $1', [t.id]);
  assert.equal(kit.logo_url, 'https://cdn.example/o.png');
  assert.deepEqual(kit.colors, { accent: '#123456' });
  assert.deepEqual((await db.query('SELECT key FROM settings WHERE tenant_id = $1', [t.id])).map((r) => r.key), ['tagline']);
});
