import crypto from 'node:crypto';
import { requirePlatformRole } from '../../auth.js';
import { platformRoutes as ROUTES } from '../../contracts/api/platform.js';
import { log, reportError } from '../../platform/log.js';
import { withTenant } from '../../tenancy.js';
import { ValidationError, normalizePhone, slugify } from '../../util.js';
import { RESERVED_LABELS, fallbackHost } from '../domains/rules.js';
import { createRawExport } from './raw-export.js';
import { BlockedAddressError } from './safe-fetch.js';
import { brandFrom, cleanWebsite, productsFrom, readSite, websiteKey } from './site-read.js';

const NOT_REACHABLE = 'Website not reachable. Check the address and try again.';
const CREATE_LOCK = 72015; // one business at a time, so two tabs can't both pass the duplicate-website check
const IMPORT_LOCK_SECONDS = 30;
const SUMMARY = 'id, slug, name, status, plan, created_at';

class Refusal extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const toSummary = (t) => ({ id: t.id, slug: t.slug, name: t.name, status: t.status, plan: t.plan, createdAt: t.created_at });
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const IG_HANDLE = /^[a-z0-9._]{1,30}$/;

/** Mounts one route of the platform contract: role check, input validation, and refusals as { error }. */
function mount(router, id, handler) {
  const route = ROUTES[id];
  router[route.method.toLowerCase()](route.path, requirePlatformRole(...route.platformRoles), async (req, res) => {
    const input = {};
    for (const part of ['params', 'query', 'body']) {
      if (!route[part]) continue;
      const parsed = route[part].safeParse(part === 'body' ? req.body ?? {} : req[part]);
      if (parsed.success) input[part] = parsed.data;
      else return part === 'params' ? res.status(404).json({ error: 'Not found.' }) : res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Check the details and try again.' });
    }
    try {
      const result = await handler({ ...input, actor: `platform:${req.platformUser.email}` });
      if (route.response === null) return res.status(route.status ?? 204).end();
      return res.status(route.status ?? 200).json(route.response.parse(result));
    } catch (err) {
      if (err instanceof Refusal) return res.status(err.status).json({ error: err.message });
      if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
      throw err;
    }
  });
}

async function freeSlug(t, name) {
  const base = slugify(name).slice(0, 36).replace(/-+$/, '') || 'business';
  for (let n = 1; n <= 200; n++) {
    const slug = n === 1 ? base : `${base}-${n}`;
    if (RESERVED_LABELS.has(slug)) continue;
    if (!(await t.query('SELECT 1 FROM tenants WHERE slug = $1', [slug])).length) return slug;
  }
  throw new Refusal(409, 'Too many businesses have this name. Choose another name.');
}

function cleanForm(body) {
  const ownerPhone = normalizePhone(body.ownerPhone);
  if (!ownerPhone) throw new Refusal(400, 'Enter the owner’s 10-digit mobile number.');
  if (body.ownerName.length < 2) throw new Refusal(400, 'Enter the owner’s name.');
  if (body.ownerEmail && !EMAIL.test(body.ownerEmail)) throw new Refusal(400, 'Enter a valid email for the owner, or leave it empty.');
  const igHandle = body.igHandle.replace(/^@/, '').toLowerCase();
  if (igHandle && !IG_HANDLE.test(igHandle)) throw new Refusal(400, 'Enter the Instagram handle without any link or spaces.');
  let website = '';
  try {
    if (body.website) website = cleanWebsite(body.website);
  } catch {
    throw new Refusal(400, NOT_REACHABLE);
  }
  return { ...body, ownerPhone, igHandle, website };
}

/** The Platform Console's create-a-business form (PRD 5.5) and what it leads to. */
export function registerBusinessRoutes(router, ctx) {
  const { db, repos, config, platform } = ctx;
  const usedBy = async (runner, website) => {
    const key = websiteKey(website);
    const rows = await runner.query(`SELECT 1 FROM tenants WHERE website <> '' AND lower(regexp_replace(regexp_replace(website, '^https?://(www\\.)?', '', 'i'), '/+$', '')) = $1 LIMIT 1`, [key]);
    return rows.length > 0;
  };
  const duplicate = () => new Refusal(409, 'This website is already used by another business. Nothing was created.');

  /** Fills a business's draft from its site. Kit changes are left alone once someone has saved a kit; products already there are not added twice. */
  async function applyRead(tenant, html, website, { firstTime }) {
    const brand = brandFrom(html, website);
    const products = productsFrom(html, website);
    return withTenant(tenant, async () => {
      let draftKit = null;
      if (brand && firstTime) {
        try {
          await repos.brandKit.save({ colors: brand.colors, ...(brand.logoUrl ? { logoUrl: brand.logoUrl } : {}) });
          draftKit = brand;
        } catch (err) {
          reportError(err, { msg: 'platform.draft_kit_failed', tenant: tenant.id });
        }
      }
      const existing = new Set((await db.query('SELECT name FROM products WHERE tenant_id = $1', [tenant.id])).map((p) => p.name.toLowerCase()));
      let imported = 0;
      for (const product of products) {
        if (existing.has(product.name.toLowerCase())) continue;
        try {
          await repos.products.create({ ...product, active: false }); // drafts wait to be published
          imported++;
        } catch (err) {
          // Whatever is odd about one product on someone's site costs that product only.
          if (!(err instanceof ValidationError)) reportError(err, { msg: 'platform.draft_product_failed', tenant: tenant.id });
        }
      }
      return { draftKit, imported };
    });
  }

  mount(router, 'platform.createBusiness', async ({ body, actor }) => {
    const form = cleanForm(body);
    if (form.website && (await usedBy(db.platform, form.website))) throw duplicate();

    let read = null;
    try {
      if (form.website) read = await readSite(form.website, config);
    } catch (err) {
      if (err instanceof BlockedAddressError) throw new Refusal(400, NOT_REACHABLE);
      throw err;
    }

    const tenant = await db.platform.tx(async (t) => {
      await t.query('SELECT pg_advisory_xact_lock($1)', [CREATE_LOCK]);
      if (form.website && (await usedBy(t, form.website))) throw duplicate();
      const [row] = await t.query(
        `INSERT INTO tenants (slug, name, plan, status, website, expected_ig_handle, billing_cycle) VALUES ($1, $2, $3, 'onboarding', $4, $5, $6) RETURNING ${SUMMARY}`,
        [await freeSlug(t, form.name), form.name.slice(0, 80), form.plan, form.website, form.igHandle, form.cycle],
      );
      return row;
    });

    try {
      await withTenant(tenant, async () => {
        // The owner's first sign-in comes through the invite (PRD 5.6), so this password is never told to anyone.
        await repos.users.create({ name: form.ownerName, phone: form.ownerPhone, email: form.ownerEmail, password: crypto.randomBytes(24).toString('base64url'), role: 'owner' });
        await repos.settings.update({ store_name: form.name });
      });
      const filled = read?.html ? await applyRead(tenant, read.html, form.website, { firstTime: true }) : { draftKit: null, imported: 0 };
      const adapter = read?.html ? (filled.imported ? 'json-ld' : 'generic') : undefined;
      // Last, because audit rows can never be deleted and everything above can still be undone.
      await withTenant(tenant, () => repos.audit.record({ actor, action: 'business.create', target: String(tenant.id), details: { plan: form.plan, cycle: form.cycle, imported: filled.imported } }));
      log.info('platform.business_created', { tenant: tenant.id, imported: filled.imported, readFailed: Boolean(read?.failed) });
      return {
        tenant: toSummary(tenant),
        draftKit: filled.draftKit,
        import: form.website ? { ...(adapter ? { adapter } : {}), canRetry: !filled.imported } : null,
      };
    } catch (err) {
      await db.platform.query('DELETE FROM tenants WHERE id = $1', [tenant.id]);
      throw err;
    }
  });

  mount(router, 'platform.retryImport', async ({ params }) => {
    const [tenant] = await db.platform.query(`SELECT ${SUMMARY}, website FROM tenants WHERE id = $1`, [params.id]);
    if (!tenant) throw new Refusal(404, 'Not found.');
    if (!tenant.website) throw new Refusal(400, 'This business has no website to read.');
    const lock = `business-import:${tenant.id}`;
    if (await platform.cache.get(lock)) return;
    await platform.cache.set(lock, { at: Date.now() }, IMPORT_LOCK_SECONDS);
    try {
      let read;
      try {
        read = await readSite(tenant.website, config);
      } catch (err) {
        if (err instanceof BlockedAddressError) throw new Refusal(400, NOT_REACHABLE);
        throw err;
      }
      if (read.failed) {
        await withTenant(tenant, () => repos.alerts.raise({ kind: 'business.import_failed', target: String(tenant.id), audience: 'ops', message: `The website import for ${tenant.name} did not finish. Try again later.` }));
        return;
      }
      const [{ saved }] = await db.platform.query('SELECT EXISTS (SELECT 1 FROM brand_kits WHERE tenant_id = $1) AS saved', [tenant.id]);
      const { imported } = await applyRead(tenant, read.html, tenant.website, { firstTime: !saved });
      log.info('platform.import_retried', { tenant: tenant.id, imported });
    } finally {
      await platform.cache.del(lock);
    }
  });

  // PRD 2, U-04: opening a business to help is on the record. This only records it; the read-only session of PRD 5.10 is a later phase.
  mount(router, 'platform.impersonate', async ({ params, body, actor }) => {
    const tenant = await repos.tenants.get(params.id);
    if (!tenant) throw new Refusal(404, 'Not found.');
    await withTenant(tenant, () => repos.audit.record({ actor, action: 'impersonation.open', target: String(tenant.id), details: { reason: body.reason } }));
    const [primary] = await db.platform.query('SELECT domain FROM tenant_domains WHERE tenant_id = $1 AND is_primary', [tenant.id]);
    return { url: `https://${primary?.domain ?? fallbackHost(tenant, config)}/admin` };
  });

  mount(router, 'platform.rawExport', ({ body, actor }) => createRawExport({ db, storage: platform.storage }, body, actor));
}
