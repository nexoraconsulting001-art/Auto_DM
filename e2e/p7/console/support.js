// Shared by the Phase 7 console browser tests (PRD 3, 5.6, 5.7, 5.12, 5.17, 5.20, 6.11, 6.12): the Phase 5 console world (the real
// app, its sign-in by WhatsApp code on the simulators, the smallest phone), with the Phase 7 part of the seller API answered from the
// browser's side by `mockApi`, so each screen's data, refusals and slow or failed answers are forced exactly. The server's own side is
// tested in test/p7. Needs a console build (npm run build:console). Nothing here leaves this machine.
export {
  PHONE, SERVER_FAULT, confirmItsYou, expectHealthy, json, openWorld, ownWorker, panel, seriousFindings, sideways, signInWithCode, toast, watch,
} from '../../p6/console/support.js';
export { refusal, writesTo } from '../../p6/console/support.js';
import { json } from '../../p5/console/support.js';

export const AT = '2026-11-14T10:00:00.000Z';
const plan = (code, name, rank, monthlyPaise, yearlyPaise, includedDms) => ({ code, name, rank, monthlyPaise, yearlyPaise, includedDms, current: code === 't2' });

export const PLAN = {
  plan: 't2', planName: 'Grow', cycle: 'monthly', status: 'active', nextChargePaise: 119_900, periodEnd: '2026-12-01T00:00:00.000Z', graceUntil: null, nextPlan: null, nextCycle: null, offer: null, hasPaymentMethod: false, items: [],
};
export const CATALOG = {
  plans: [plan('free', 'Free', 0, 0, 0, 100), plan('t1', 'Start', 1, 59_900, 599_000, 500), plan('t2', 'Grow', 2, 119_900, 1_199_000, 2000), plan('t3', 'Shop', 3, 249_900, 2_499_000, 5000), plan('t4', 'Scale', 4, 499_900, 4_999_000, 20_000), plan('t5', 'Brand', 5, 999_900, 9_999_000, null)],
  addons: [
    { code: 'ai_replies', name: 'AI replies', kind: 'addon', pricePaise: 49_900, cycle: 'monthly', feature: 'ai_replies', minPlan: 't2', includedFrom: 't4', meter: null, units: null, many: false, available: true, unavailable: null },
    { code: 'whatsapp', name: 'WhatsApp automation', kind: 'addon', pricePaise: 79_900, cycle: 'monthly', feature: 'whatsapp_automation', minPlan: 't2', includedFrom: 't5', meter: null, units: null, many: false, available: false, unavailable: 'needs_plan' },
    { code: 'dm_pack_1000', name: '1,000 DM pack', kind: 'pack', pricePaise: 29_900, cycle: 'one_time', feature: null, minPlan: 't1', includedFrom: null, meter: 'dms', units: 1000, many: true, available: true, unavailable: null },
  ],
  taxRateBp: 1800,
  offer: null,
};
export const USAGE = {
  month: '2026-11-01', resetsAt: '2026-12-01T00:00:00.000Z', heldDms: 0, canBuyPacks: true,
  meters: [
    { meter: 'dms', used: 1700, included: 2000, packUnits: 0, allowance: 2000, left: 300, percent: 85, over: false },
    { meter: 'whatsapp_messages', used: 0, included: null, packUnits: 0, allowance: null, left: null, percent: 0, over: false },
  ],
};
export const INVOICE = {
  id: 5, docType: 'invoice', number: 'BH/2026-27/000005', issuedAt: AT, periodStart: '2026-11-01', periodEnd: '2026-11-30', originalInvoiceId: null, taxablePaise: 119_900, cgstPaise: 10_791, sgstPaise: 10_791, igstPaise: 0, totalPaise: 141_482, paid: true, hasFile: true, lines: [],
};
export const STATEMENT = {
  id: 3, month: '2026-10-01', openingBalance: { amountPaise: 0, owedTo: 'business' }, salesPaise: 500_000, refundsPaise: 0, gatewayFeesPaise: 11_800, shippingPaise: 40_000, commissionPaise: 0, payoutsPaise: 448_200,
  closingBalance: { amountPaise: 0, owedTo: 'business' }, counts: { orders: 12, refunds: 0, shipments: 12 }, payouts: [], reconciliation: 'matched', hasPdf: true, hasCsv: true, sentAt: AT,
};
const step = (name, label, status, extra = {}) => ({ step: name, label, required: true, status, checkedAt: AT, code: '', reason: '', fix: '', ...extra });
export const CHECKLIST = {
  plan: 't3', done: false, checkoutOpen: false, kyc: { status: 'under_review', reason: '' },
  steps: [
    step('instagram', 'Connect Instagram', 'done'),
    step('terms', 'Accept the terms', 'pending', { fix: 'terms' }),
    step('payments', 'Set up payments', 'waiting', { reason: 'Razorpay is reviewing your documents.', fix: 'kyc' }),
    step('shipping', 'Add your pickup address', 'failed', { code: 'pickup.missing', reason: 'We need a pickup address.', fix: 'pickup' }),
    step('own_keys', 'Bring your own payment or courier account', 'pending', { required: false, fix: 'keys' }),
  ],
};
export const REFERRALS = { code: 'asha1234', link: 'https://app.bhava.example/signup?ref=asha1234', rewardPaise: 25_000, counts: { pending: 1, credited: 2, blocked: 0 }, creditedPaise: 50_000 };
export const AI = { enabled: false, threshold: 0.8, configured: true, faqCount: 1, canEnable: true };
export const FAQ = { id: 1, question: 'When will my order arrive?', answer: 'In three to five days.', active: true, updatedAt: AT };
export const WA = { connected: false, status: null, displayName: '', displayNumber: '', connectedAt: null, signupReady: true };
export const KEYWORDS = { items: [{ id: 1, keywords: ['link', 'price'], reelId: null, linkUrl: 'https://kesar.in/shop', message: 'Here you go: {link}', active: true }] };
export const REEL = { id: '12', slug: 'diwali', headline: 'Diwali box', keywords: [], dmMessage: '', buttonText: '', publicReply: '', active: true, permalink: '', thumbnailUrl: '', productCount: 0, dmCount: 0, visitCount: 0, orderCount: 0 };
export const CHANGE = (over) => ({ id: 1, service: 'reel_management', taskRef: 'TASK-9', routeId: 'automations.update', target: 'LINK on Diwali reel', before: { keyword: 'link' }, after: { keyword: 'diwali' }, state: 'applied', canUndo: true, createdAt: AT, decidedAt: null, undoneAt: null, ...over });

const page = (items) => ({ items, nextCursor: null });

/** The default answers. A test passes `overrides` ({ 'GET /billing': (call) => ... }) to change one. */
export const defaults = (state) => ({
  'GET /billing': () => state.plan,
  'GET /billing/catalog': () => CATALOG,
  'GET /billing/usage': () => USAGE,
  'GET /billing/invoices': () => page([INVOICE]),
  'GET /billing/invoices/5/file': () => ({ fileUrl: 'https://files.example/invoice-5.pdf', fileName: 'invoice-5.pdf', expiresAt: AT }),
  'GET /billing/statements': () => page([STATEMENT]),
  'GET /billing/statements/3/file': ({ url }) => ({ fileUrl: `https://files.example/statement-3.${url.searchParams.get('format')}`, fileName: 'statement', expiresAt: AT }),
  'POST /billing/change': ({ body }) => ({ plan: { ...state.plan, plan: body.plan }, effective: 'now', checkoutUrl: 'https://checkout.example/pay/sub_1' }),
  'POST /billing/items': ({ body }) => json({ item: { id: 9, code: body.code, name: body.code, kind: 'addon', cycle: 'monthly', quantity: 1, unitPricePaise: 49_900, startsAt: AT, endsAt: null }, checkoutUrl: null }, 201),
  'POST /billing/payment-method': () => ({ url: 'https://checkout.example/method/m_1', expiresAt: null }),
  'DELETE /billing/items/9': () => ({ status: 204, contentType: 'application/json', body: '' }),
  'GET /referrals': () => REFERRALS,
  'GET /setup': () => state.checklist,
  'POST /setup/check': () => state.checklist,
  'POST /setup/terms': () => state.checklist,
  'POST /setup/kyc-link': () => ({ url: 'https://kyc.example/route/acc_1', status: 'created', reason: '' }),
  'PUT /setup/pickup-address': () => state.checklist,
  'PUT /setup/own-keys': ({ body }) => ({ provider: body.provider, keyId: body.keyId, masked: '****', checklist: state.checklist }),
  'GET /ai-replies': () => state.ai,
  'PATCH /ai-replies': ({ body }) => (state.ai = { ...state.ai, ...body }),
  'GET /faq': () => page([FAQ]),
  'POST /faq': ({ body }) => json({ ...FAQ, id: 2, ...body, updatedAt: AT }, 201),
  'POST /ai-replies/test': () => ({ answer: 'In three to five days.', sources: [{ kind: 'faq', id: 1, label: 'When will my order arrive?' }], score: 0.91, threshold: 0.8, wouldSend: true, reason: '' }),
  'GET /ai-replies/log': () => page([{ id: 1, channel: 'instagram', threadId: 4, question: 'Do you deliver to Pune?', answer: 'Yes.', sourceIds: ['faq:1'], score: 0.9, model: 'm', outcome: 'answered', reason: '', at: AT }]),
  'GET /whatsapp': () => state.whatsapp,
  'POST /whatsapp/connect': () => ({ appId: '1234567890', configId: '555666777', state: 'state-one' }),
  'POST /whatsapp/connect/finish': () => (state.whatsapp = { connected: true, status: 'active', displayName: 'Kesar Kitchen', displayNumber: '+91 98xxx xx210', connectedAt: AT, signupReady: true }),
  'DELETE /whatsapp': () => { state.whatsapp = WA; return { status: 204, contentType: 'application/json', body: '' }; },
  'GET /whatsapp/keywords': () => state.keywords,
  'PUT /whatsapp/keywords': ({ body }) => (state.keywords = { items: body.items.map((item, i) => ({ id: item.id ?? 10 + i, message: '', ...item })) }),
  'GET /whatsapp/optins': () => page([{ id: 1, purpose: 'marketing', source: 'checkout', optedInAt: AT, withdrawnAt: null }, { id: 2, purpose: 'order_updates', source: 'form', optedInAt: AT, withdrawnAt: AT }]),
  'GET /reels': () => page([REEL]),
  'GET /team-feed': () => page(state.changes),
  'POST /team-feed/1/undo': () => CHANGE({ state: 'undone', canUndo: false }),
  'POST /team-feed/2/approve': () => CHANGE({ id: 2, state: 'approved' }),
  'POST /team-feed/3/reject': () => CHANGE({ id: 3, state: 'rejected', canUndo: false }),
  'GET /signup': () => state.signup,
  'POST /signup': ({ body }) => { state.signup = { ...state.signup, tenantId: 7, accountType: body.accountType, steps: [{ step: 'account_type', at: AT }], next: 'instagram_connected' }; return json({ tenantId: 7, slug: 'kesar', host: 'kesar.shops.example', runToken: 'run-1', next: 'instagram_connected' }, 201); },
  'GET /instagram/connection': () => state.instagram,
  'GET /instagram/media': () => page([{ id: '17900000000001', type: 'reel', caption: 'Diwali box reel', permalink: '', thumbnailUrl: '', postedAt: AT, automationId: null }]),
  'POST /signup/first-automation': () => { state.signup = { ...state.signup, steps: [...state.signup.steps, { step: 'instagram_connected', at: AT }, { step: 'automation_live', at: AT }] }; return { automationId: 4, live: true, problems: [] }; },
  'POST /signup/finish': () => ({ tenantId: 7, host: 'kesar.shops.example', elapsedMs: 150_000, withinTarget: true }),
});

export const freshState = () => ({
  plan: PLAN,
  checklist: CHECKLIST,
  ai: AI,
  whatsapp: WA,
  keywords: KEYWORDS,
  changes: [CHANGE({}), CHANGE({ id: 2, state: 'draft', canUndo: false, routeId: 'categories.update' }), CHANGE({ id: 3, state: 'draft', canUndo: false, routeId: 'pages.update' })],
  signup: { mode: 'public', signedIn: true, open: true, runToken: 'run-1', tenantId: null, accountType: null, steps: [{ step: 'opened', at: AT }, { step: 'signed_in', at: AT }], next: 'account_type' },
  instagram: { status: 'active', igUserId: '1790', username: 'kesar.home', loginKind: 'instagram', scopes: [], missingScopes: [], insightsGranted: true, tokenExpiresAt: null, health: 'ok', webhooksSubscribed: true },
});

const AREA = /\/api\/v1\/(billing|referrals|setup|ai-replies|faq|whatsapp|reels|team-feed|signup|instagram\/(connection|media))(\/|\?|$)/;

/**
 * Answers the Phase 7 routes in `page` from `defaults` and `overrides`. Returns { calls, state }: `calls` is every request as
 * { key: 'POST /billing/change', body }. An answer may be a plain object (200) or a json(...) / { status, body } reply.
 */
export async function mockApi(page, { overrides = {}, state = freshState() } = {}) {
  const calls = [];
  const answers = { ...defaults(state), ...overrides };
  await page.route(AREA, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const key = `${request.method()} ${url.pathname.replace('/api/v1', '')}`;
    const body = request.postData() ? JSON.parse(request.postData()) : null;
    calls.push({ key, body });
    const answer = answers[key];
    if (!answer) return route.fulfill(json({ error: 'This isn’t available yet.', code: 'not_implemented' }, 501));
    const reply = await answer({ body, url, calls });
    return route.fulfill(typeof reply?.status === 'number' && typeof reply?.contentType === 'string' ? reply : json(reply ?? {}));
  });
  return { calls, state };
}

/** A plan refusal as the router answers it. */
export const planRefusal = (code, extra = {}) => json({ error: code === 'plan.limit_reached' ? 'You have used all of this on your plan.' : 'This isn’t on your plan.', code, reason: 'plan', ...extra }, 403);
