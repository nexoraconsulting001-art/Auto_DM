import fs from 'node:fs';
import path from 'node:path';
import { catalogue } from '../../strings.js';

/** The analytics and catalog features, and every line their screens ask for by a written-out key. */
const FEATURES = ['insights', 'reach-guard', 'traffic', 'reports', 'products', 'imports', 'categories', 'pages', 'themes', 'brand-kit', 'creator', 'leads'];
const files = FEATURES.flatMap((name) => {
  const dir = path.join(__dirname, '..', name);
  return fs.readdirSync(dir).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js')).map((f) => ({ file: `${name}/${f}`, text: fs.readFileSync(path.join(dir, f), 'utf8') }));
});

test('every line these screens ask for exists in English and in Hindi', () => {
  const missing = [];
  for (const { file, text } of files) {
    for (const [, key] of text.matchAll(/\bt\(\s*'([a-z][\w-]*\.[\w.-]+)'/g)) {
      for (const locale of ['en', 'hi']) if (typeof catalogue[locale][key] !== 'string') missing.push(`${file}: ${key} (${locale})`);
    }
  }
  expect(missing).toEqual([]);
});

test('the keys these screens build from a code have a line for every code they can be given', () => {
  const families = {
    'products.status.': ['all', 'active', 'attention', 'price_changed', 'sold_out', 'featured', 'archived'],
    'imports.item.': ['pending', 'draft', 'created', 'updated', 'unchanged', 'existing', 'refused', 'failed', 'archived'],
    'imports.job.': ['queued', 'running', 'done', 'failed'],
    'imports.kind.': ['link', 'bulk', 'csv', 'shopify', 'adapter'],
    'pages.block.': ['hero', 'ticker', 'products', 'more_reels', 'shelves', 'lead_form', 'trust', 'banner', 'countdown', 'testimonials', 'faq', 'video', 'bulk_order', 'whatsapp'],
    'leads.channel.': ['whatsapp', 'sms', 'email', 'call'],
    'leads.source.': ['all', 'landing', 'creator', 'store', 'bio'],
    'reports.source.': ['explore', 'funnel', 'cohort', 'account_daily', 'media', 'story_finals', 'content_funnel', 'health_history'],
    'reports.file.': ['queued', 'running', 'ready', 'failed', 'expired'],
    'reports.run.': ['building', 'sent', 'failed', 'skipped'],
    'categories.rule.': ['hashtag', 'caption_keyword', 'product_category'],
    'themes.site.status.': ['read', 'script_only', 'failed', 'blocked'],
  };
  const missing = [];
  for (const [prefix, codes] of Object.entries(families)) {
    for (const code of codes) for (const locale of ['en', 'hi']) if (typeof catalogue[locale][`${prefix}${code}`] !== 'string') missing.push(`${prefix}${code} (${locale})`);
  }
  expect(missing).toEqual([]);
});
