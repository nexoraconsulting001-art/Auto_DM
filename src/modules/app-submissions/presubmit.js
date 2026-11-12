import fs from 'node:fs';
import { SHOPPER_PUSH_TOGGLES } from '../../contracts/apps.js';
import { tenantId } from '../../tenancy.js';
import { runChecks } from '../../../tools/presubmit/checks.mjs';

/**
 * The server's run of the pre-submit gate (tools/presubmit/checks.mjs) for one build. The server image holds no app source, so
 * what the binary contains comes from release-facts.json beside this file: the facts every brand's build of an app version
 * shares, written by `node tools/presubmit/index.mjs --release-facts --write` (test/p6/store-release keeps it equal to the app).
 * What only the server knows it adds itself: review access for this business's app, that it answers the account deletion route,
 * the notification switches, and the brand's own names, ids and hosts.
 */
const RELEASE_FACTS = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL('./release-facts.json', import.meta.url), 'utf8'));
  } catch {
    return { releases: {} };
  }
})();
export const PRESUBMIT_TOOL_VERSION = `${RELEASE_FACTS.toolVersion ?? 'presubmit'}+server`;
const FROM_THE_APP = new Set(['native_screens', 'account_deletion', 'gateway_payments', 'push_opt_in_out', 'target_api', 'ios_sdk', 'privacy_manifest']);

/** The release facts of an app version, or null. */
export const releaseFactsOf = (appVersion) => RELEASE_FACTS.releases?.[String(appVersion)] ?? null;

/** What the server knows for this business's app: review access, its routes, the switches, the brand's texts. */
export async function serverFacts(ctx) {
  const [config] = await ctx.db.query('SELECT * FROM app_configs WHERE tenant_id = $1', [tenantId()]);
  const modules = Array.isArray(ctx.modules) ? ctx.modules : [];
  return {
    reviewAccess: { enabled: config?.review_enabled === true, phone: Boolean(config?.review_phone), code: Boolean(config?.review_code_hash) },
    accountDeletionRoute: modules.some((m) => Array.isArray(m.owns?.store) && m.owns.store.includes('appAccountDelete')),
    push: { toggles: [...SHOPPER_PUSH_TOGGLES], defaultOn: [] },
    brand: {
      texts: config ? [config.app_name, config.short_name, config.android_package, config.ios_bundle_id, config.url_scheme, config.shop_domain, config.support_email, config.privacy_url].filter((t) => typeof t === 'string' && t) : [],
    },
  };
}

/** Every check for the build's platform: { passed, checks, toolVersion }. */
export async function presubmitBuild(ctx, build) {
  const app = releaseFactsOf(build.app_version);
  const { checks } = runChecks({ platform: build.platform, app: app ?? {}, server: await serverFacts(ctx) });
  const out = app ? checks : checks.map((c) => (FROM_THE_APP.has(c.code)
    ? { ...c, passed: false, detail: `The server has no pre-submit facts for app version ${build.app_version}. Run node tools/presubmit/index.mjs --release-facts --write and deploy.` }
    : c));
  return { checks: out, toolVersion: PRESUBMIT_TOOL_VERSION };
}
