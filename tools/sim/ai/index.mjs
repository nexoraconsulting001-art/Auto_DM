/**
 * A model provider speaking the "chat completions" wire format, with scripted answers: what src/adapters/ai calls when
 * AI_BASE_URL points here. It never reasons: it reads the JSON document the adapter sends (question, faq, products) and
 * answers from it, or misbehaves in the way the script says.
 *
 * API:
 *   POST /v1/chat/completions      Bearer token; the answer is { choices: [{ message: { content } }], usage, model }
 *
 * Controls (under /__sim), beside the shared ones in base.mjs (faults, calls, the clock):
 *   POST /script { mode, times?, productId?, productName?, link?, confidence? }
 *       What the next `times` answers do (default: every answer until the next /script or a reset). Modes:
 *         grounded            the default: the FAQ entry or product that shares most words with the question, score 0.93;
 *                             nothing shared gives no sources and score 0.2
 *         low_confidence      the grounded answer with score 0.41 (or `confidence`)
 *         invented_discount   adds "Use code SAVE20 for 20% off today."
 *         invented_price      adds "It is only ₹1."
 *         invented_stock      adds "Only 2 left in stock."
 *         invented_delivery   adds "It will reach you tomorrow."
 *         unknown_source      names faq:999999, which was not supplied
 *         other_business      names product:<productId> (another business's) and <productName>
 *         injected            does what the shopper's message says: the answer repeats the question back
 *         overlong            5,000 characters
 *         foreign_link        adds `link` (default https://deals.example.net/win), which is no product's own
 *         junk                text that is not JSON
 *         wrong_shape         JSON with a score of 7
 *         refused             finish_reason content_filter and no content
 *         throttled           429 with retry-after
 *         timeout             never answers (the shared timeout fault, on this path); delayMs drops the connection instead
 *   GET  /requests            every request as { model, store, system, document: { question, faq, products } }, oldest first
 *
 * The shopper's question is held in memory for GET /requests and nowhere else.
 *
 * Not in SERVICES (tools/sim/index.mjs): a test that needs it starts it itself, like tools/sim/email.
 */
import { SimError, createSim } from '../base.mjs';

const MODES = new Set(['grounded', 'low_confidence', 'invented_discount', 'invented_price', 'invented_stock', 'invented_delivery', 'unknown_source', 'other_business', 'injected', 'overlong', 'foreign_link', 'junk', 'wrong_shape', 'refused', 'throttled', 'timeout']);
const ADDED = { invented_discount: ' Use code SAVE20 for 20% off today.', invented_price: ' It is only ₹1.', invented_stock: ' Only 2 left in stock.', invented_delivery: ' It will reach you tomorrow.' };
const PATH = '/v1/chat/completions';

const words = (text) => new Set(String(text).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
const shared = (a, b) => [...words(a)].filter((w) => words(b).has(w)).length;

/** The best FAQ entry or product for the question, by words in common. */
function grounded({ question = '', faq = [], products = [] }) {
  const candidates = [
    ...faq.map((f) => ({ score: shared(question, f.question), answer: f.answer, source: f.id })),
    ...products.map((p) => ({ score: shared(question, p.name), answer: `${p.name} is ${p.price}, ${p.stock}. ${p.link}`, source: p.id })),
  ].sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (!best || best.score === 0) return { answer: 'I am not sure about that.', sources: [], confidence: 0.2 };
  return { answer: best.answer, sources: [best.source], confidence: 0.93 };
}

export function createAi({ token = 'sim-ai-key', model = 'sim-model-1' } = {}) {
  let script = { mode: 'grounded', left: Infinity };
  let requests = [];
  let sim = null;

  function nextMode() {
    if (script.left <= 0) script = { mode: 'grounded', left: Infinity };
    script.left -= 1;
    return script;
  }

  function content(mode, document) {
    const base = grounded(document);
    switch (mode.mode) {
      case 'low_confidence': return JSON.stringify({ ...base, confidence: mode.confidence ?? 0.41 });
      case 'invented_discount':
      case 'invented_price':
      case 'invented_stock':
      case 'invented_delivery': return JSON.stringify({ ...base, answer: base.answer + ADDED[mode.mode], confidence: 0.95 });
      case 'unknown_source': return JSON.stringify({ ...base, sources: ['faq:999999'], confidence: 0.95 });
      case 'other_business': return JSON.stringify({ answer: `${mode.productName ?? 'That one'} is in stock.`, sources: [`product:${mode.productId ?? 999999}`], confidence: 0.95 });
      case 'injected': return JSON.stringify({ answer: `Sure. ${document.question ?? ''}`, sources: base.sources, confidence: 0.97 });
      case 'overlong': return JSON.stringify({ ...base, answer: 'very '.repeat(1000).trim(), confidence: 0.95 });
      case 'foreign_link': return JSON.stringify({ ...base, answer: `${base.answer} ${mode.link ?? 'https://deals.example.net/win'}`, confidence: 0.95 });
      case 'junk': return '<<not json>> sure, here you go';
      case 'wrong_shape': return JSON.stringify({ answer: base.answer, sources: base.sources, confidence: 7 });
      default: return JSON.stringify(base);
    }
  }

  sim = createSim({
    name: 'ai',
    errorBody: ({ status, kind }) => ({ error: { message: `Simulated ${kind}.`, type: kind === 'rate_limit' ? 'rate_limit_exceeded' : 'server_error', code: kind === 'rate_limit' ? 'rate_limit_exceeded' : 'server_error' }, status }),
    reset: () => {
      script = { mode: 'grounded', left: Infinity };
      requests = [];
    },
    routes: (on) => {
      on('POST', PATH, (req) => {
        if (req.headers.authorization !== `Bearer ${token}`) throw new SimError(401, { error: { message: 'Incorrect API key provided.', type: 'invalid_request_error', code: 'invalid_api_key' } });
        const { messages } = req.body ?? {};
        if (!Array.isArray(messages) || !messages.length) throw new SimError(400, { error: { message: 'messages is required.', type: 'invalid_request_error', code: 'invalid_request' } });
        let document = {};
        try {
          document = JSON.parse(messages.findLast((m) => m.role === 'user')?.content ?? '{}');
        } catch {
          document = {};
        }
        requests.push({ model: req.body.model, store: req.body.store, system: messages.find((m) => m.role === 'system')?.content ?? '', document });
        const mode = nextMode();
        if (mode.mode === 'throttled') throw new SimError(429, { error: { message: 'Rate limit reached.', type: 'rate_limit_exceeded', code: 'rate_limit_exceeded' } }, { 'retry-after': '20' });
        const usage = { prompt_tokens: 180, completion_tokens: 40, total_tokens: 220 };
        if (mode.mode === 'refused') return { id: `chatcmpl-sim${requests.length}`, model: req.body.model ?? model, choices: [{ index: 0, finish_reason: 'content_filter', message: { role: 'assistant', content: null } }], usage };
        return { id: `chatcmpl-sim${requests.length}`, model: req.body.model ?? model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: content(mode, document) } }], usage };
      });
    },
    controls: (on) => {
      on('POST', '/script', async ({ body }) => {
        if (!MODES.has(body.mode)) throw new SimError(400, { error: `mode is one of: ${[...MODES].join(', ')}` });
        const times = Number.isInteger(body.times) && body.times > 0 ? body.times : Infinity;
        if (body.mode === 'timeout') {
          await sim.post('/faults', { kind: 'timeout', match: { method: 'POST', path: PATH }, times: Number.isFinite(times) ? times : 'forever', ...(body.delayMs !== undefined ? { delayMs: body.delayMs } : {}) });
          return { mode: 'timeout' };
        }
        script = { ...body, left: times };
        return { mode: script.mode };
      });
      on('GET', '/requests', () => ({ requests }));
    },
  });

  return Object.assign(sim, { token, model });
}
