/**
 * Where each route's plan check lives (PRD 5.7: entitlements are checked on every route). Plain data with no imports.
 *
 * A route in the contract is exactly one of:
 *
 *   gated              it names `feature` or `limit` in the route table, and the router checks it before the handler
 *   PLAN_IN_HANDLER    the answer depends on the request (which trigger, which platform, how many products, switching
 *                      something on rather than off), so its handler asks repos.entitlements. The features it asks about
 *                      are listed, for the console and the app
 *   PLAN_NOT_ENFORCED  it belongs to a paid feature in PRD 3 and nothing refuses it yet: Phase 0 to 4 answer these on
 *                      every plan, and their tests run on a Free business. Named here with the feature each would take,
 *                      so closing one is moving its line into the route table. Until then this is a known gap, not a rule
 *   ALWAYS_ON          every plan may call it: sign-in, the account, compliance, analytics and Reach Guard (on in every
 *                      tier), and everything that reads, exports or removes what a business already has. A downgrade
 *                      keeps the data and keeps it manageable (5.7, F-34), so only starting or switching on is gated
 *
 * test/p7/contract keeps the four apart and complete: a new route that is in none of them fails there.
 */
export const PLAN_IN_HANDLER = Object.freeze({
  'automations.create': Object.freeze(['automations', 'triggers.comment', 'triggers.story_dm', 'links.one_tap']),
  'automations.update': Object.freeze(['automations', 'triggers.comment', 'triggers.story_dm', 'links.one_tap']),
  'automations.setState': Object.freeze(['automations']),
  'pages.create': Object.freeze(['reel.products', 'whatsapp_order']),
  'pages.update': Object.freeze(['reel.products', 'whatsapp_order']),
  'pageSettings.update': Object.freeze(['whatsapp_order']),
  'leadForms.get': Object.freeze(['lead_form']),
  'cohorts.get': Object.freeze(['cohorts.buyers']),
  'scheduledReports.update': Object.freeze(['reports.scheduled']),
  'cartReminders.update': Object.freeze(['store.cart_reminders']),
  'appPublishing.requestBuild': Object.freeze(['app.android', 'app.ios']),
  'appPublishing.submissions': Object.freeze(['app.android', 'app.ios']),
  'pushCampaigns.send': Object.freeze(['app.android', 'app.ios']),
  'pushCredentials.save': Object.freeze(['app.android', 'app.ios']),
});

export const PLAN_NOT_ENFORCED = Object.freeze({
  'products.create': 'catalog',
  'catalogSettings.update': 'catalog',
  'categories.create': 'shop_page',
  'facebook.connect': 'facebook',
  'facebook.saveLink': 'facebook',
  'brandKit.update': 'brand_kit',
  'paymentSettings.update': 'store.payments',
  'inventory.adjust': 'store.inventory',
  'inventorySettings.update': 'store.inventory',
  'invoiceSettings.update': 'store.invoices',
  'returnSettings.update': 'store.returns',
  'alertSettings.update': 'store.order_alerts',
  'whatsappAccount.connect': 'store.order_alerts',
});

export const ALWAYS_ON = Object.freeze([
  'auth.login', 'auth.start', 'auth.verify', 'auth.exchange', 'auth.apple', 'auth.refresh', 'auth.me', 'auth.logout', 'auth.businesses', 'auth.devices', 'auth.revokeDevice', 'auth.reauthStart', 'auth.reauthVerify', 'auth.enableDeviceUnlock', 'auth.linkIdentity', 'auth.deleteAccount',
  'products.list', 'products.get', 'products.update', 'products.remove', 'products.recheck',
  'catalogSettings.get',
  'categories.list', 'categories.reorder', 'categories.get', 'categories.update', 'categories.remove', 'categories.reels', 'categories.rules',
  'categoryRules.remove',
  'reels.list', 'reels.get', 'reels.save', 'reels.remove', 'reels.instagramPosts',
  'orders.list', 'orders.get', 'orders.setStatus', 'orders.timeline', 'orders.advance', 'orders.cancel', 'orders.releaseHold', 'orders.reinstate', 'orders.addNote',
  'orderDownloads.list', 'orderDownloads.create', 'orderDownloads.get',
  'customers.list', 'customers.resetPassword',
  'settings.get', 'settings.update', 'settings.updatePayment', 'settings.setup',
  'brandKit.get', 'brandKit.presets',
  'activity.list',
  'stats.dashboard',
  'media.upload',
  'audit.list',
  'instagram.connection', 'instagram.connect', 'instagram.disconnect', 'instagram.media',
  'compliance.status', 'compliance.pause', 'compliance.resume', 'compliance.settings', 'compliance.updateSettings', 'compliance.activity', 'compliance.whyNoDm', 'compliance.heldJobs', 'compliance.discardHeld', 'compliance.slowModeOverride', 'compliance.words', 'compliance.addWord', 'compliance.removeWord',
  'automations.list', 'automations.preview', 'automations.get', 'automations.remove', 'automations.pickWinner', 'automations.stats', 'automations.sendTest',
  'testers.list', 'testers.createCode', 'testers.remove',
  'iceBreakers.get', 'iceBreakers.save',
  'inbox.threads', 'inbox.thread', 'inbox.reply', 'inbox.needsHuman', 'inbox.resolve',
  'links.preview', 'links.check', 'links.taps',
  'measurementIds.list', 'measurementIds.create', 'measurementIds.update', 'measurementIds.remove',
  'facebook.connection', 'facebook.disconnect', 'facebook.posts', 'facebook.links', 'facebook.suggestions', 'facebook.removeLink',
  'domains.list', 'domains.setPrimary', 'domains.check', 'domains.remove',
  'alerts.list', 'alerts.markRead',
  'explore.catalog', 'explore.query',
  'savedViews.list', 'savedViews.create', 'savedViews.get', 'savedViews.update', 'savedViews.remove', 'savedViews.pin', 'savedViews.unpin',
  'dashboard.cards',
  'funnels.list', 'funnels.create', 'funnels.get', 'funnels.update', 'funnels.remove', 'funnels.results',
  'downloads.list', 'downloads.create', 'downloads.get',
  'reports.list', 'reports.preferences', 'reports.updatePreferences', 'reports.unsubscribe', 'reports.get',
  'scheduledReports.list', 'scheduledReports.remove', 'scheduledReports.addRecipient', 'scheduledReports.removeRecipient',
  'apiKeys.list', 'apiKeys.revoke',
  'insights.status', 'insights.account', 'insights.audience', 'insights.media', 'insights.mediaDetail', 'insights.stories', 'insights.funnels', 'insights.funnel', 'insights.top', 'insights.bestTime', 'insights.refresh',
  'destinations.connections', 'destinations.setSiteTag', 'destinations.reports', 'destinations.uploadReport',
  'reachGuard.status', 'reachGuard.setThresholds', 'reachGuard.trips',
  'accountHealth.get', 'accountHealth.history',
  'traffic.summary', 'traffic.sources', 'traffic.trend', 'traffic.heatmap', 'traffic.pages', 'traffic.breakdown', 'traffic.realtime',
  'tags.get', 'tags.update', 'tags.health',
  'imports.list', 'imports.adapters', 'imports.get', 'imports.items',
  'importItems.save',
  'pages.list', 'pages.media', 'pages.get', 'pages.remove',
  'pageSettings.get',
  'pageBlocks.get', 'pageBlocks.save',
  'themes.presets', 'themes.get', 'themes.updateText', 'themes.readSite', 'themes.siteReads', 'themes.applySiteRead',
  'creator.get', 'creator.checkSlug',
  'leads.list', 'leads.get', 'leads.remove', 'leads.revokeConsent',
  'leadDownloads.list', 'leadDownloads.create', 'leadDownloads.get',
  'paymentSettings.get',
  'paymentAccount.get', 'paymentAccount.disconnect',
  'payments.forOrder',
  'settlements.list', 'settlements.summary',
  'refunds.forOrder', 'refunds.create', 'refunds.get', 'refunds.retry',
  'shippingSettings.get',
  'shipping.serviceability',
  'shipments.forOrder', 'shipments.get', 'shipments.cancel', 'shipments.label',
  'inventory.list', 'inventory.movements',
  'inventorySettings.get',
  'invoiceSettings.get',
  'invoices.list', 'invoices.get',
  'returnSettings.get',
  'returns.list', 'returns.get', 'returns.approve', 'returns.decline', 'returns.receive', 'returns.close',
  'alertSettings.get',
  'whatsappAccount.get', 'whatsappAccount.disconnect',
  'whatsappTemplates.all', 'whatsappTemplates.sync',
  'orderAlerts.list', 'orderAlerts.retry',
  'cartReminders.get', 'cartReminders.stats',
  'shopify.get', 'shopify.setMode', 'shopify.disconnect', 'shopify.reconcile', 'shopify.conflicts',
  'shoppers.list', 'shoppers.get',
  'shopperDownloads.list', 'shopperDownloads.create', 'shopperDownloads.get',
  'privacy.get', 'privacy.update',
  'policies.all', 'policies.save',
  'consentNotice.get', 'consentNotice.publish',
  'dataRequests.list', 'dataRequests.create', 'dataRequests.get',
  'team.list', 'team.update', 'team.remove',
  'app.requirements',
  'notifications.list', 'notifications.markRead', 'notifications.prefs', 'notifications.savePrefs',
  'push.register', 'push.unregister',
  'appPublishing.get', 'appPublishing.save', 'appPublishing.validate', 'appPublishing.builds',
  'appListing.get', 'appListing.assets',
  'pushCampaigns.list', 'pushCampaigns.summary',
  'pushCredentials.get',
  'billing.plan', 'billing.catalog', 'billing.change', 'billing.addItem', 'billing.removeItem', 'billing.usage', 'billing.invoices', 'billing.invoiceFile', 'billing.statements', 'billing.statementFile', 'billing.paymentMethod', 'billing.features',
  'referrals.get',
  'signup.status', 'signup.start', 'signup.firstAutomation', 'signup.finish',
]);

/**
 * The `reason` a plan refusal carries beside its code. The Phase 3 screens look for 'plan.not_included' (PLAN_REASON in
 * src/contracts/catalog.js) and the later ones for 'plan', as their handlers answered before the router took the check
 * over. New code branches on the code (`plan.feature_off`, `plan.limit_reached`), never on this.
 */
const NOT_INCLUDED_ROUTES = Object.freeze([
  'imports.link', 'imports.bulk', 'imports.csv', 'imports.shopify', 'categories.setReels', 'categories.addReel', 'categories.removeReel', 'categories.pin', 'categories.unpin', 'categories.schedule', 'categories.addRule', 'categoryRules.update', 'categoryRules.apply', 'themes.choose', 'creator.update', 'leadForms.update', 'leadForms.setConsent',
]);
export const planRefusalReason = (routeId) => (NOT_INCLUDED_ROUTES.includes(routeId) ? 'plan.not_included' : 'plan');

/** True for the two codes the router answers from the route table. */
export const isPlanRefusal = (error) => error?.code === 'plan.feature_off' || error?.code === 'plan.limit_reached';
