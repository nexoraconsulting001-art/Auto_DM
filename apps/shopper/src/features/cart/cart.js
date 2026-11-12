/**
 * The bag, kept on the device as what the shopper chose and nothing else: product, variant and quantity. It holds no price,
 * total or discount; the server prices the bag (checkout quote) and the screens draw what it answers. A signed-in shopper's bag
 * is also kept on the server (PUT /api/store/cart merges it), so it follows them to another phone.
 *
 *   const cart = createCart({ storage, storageKey, remote });
 *   cart.add({ productId, variantId, qty });   cart.setQty(key, qty);   cart.remove(key);   cart.clear();
 *   cart.lines    [{ productId, variantId, qty }], frozen     cart.count     items in the bag
 *   cart.subscribe(listener)
 *
 * `storage` is a key-value store ({ getItem, setItem, removeItem }, async), or null for memory only. `remote` is
 * { active(): boolean, put(lines): Promise<lines | null> } and is used only while a shopper is signed in.
 */
export const MAX_QTY = 1000;
export const MAX_LINES = 50;

export const keyOf = (line) => `${line.productId}:${line.variantId ?? ''}`;

const whole = (value) => Number.isInteger(value) && value > 0;

/** Lines read back from the device or the server: only whole product and variant ids and a quantity of 1 or more survive. */
export function cleanLines(value) {
  if (!Array.isArray(value)) return [];
  const merged = new Map();
  for (const entry of value) {
    if (!entry || !whole(entry.productId) || !(entry.variantId === null || entry.variantId === undefined || whole(entry.variantId)) || !whole(entry.qty)) continue;
    const line = { productId: entry.productId, variantId: entry.variantId ?? null, qty: Math.min(MAX_QTY, entry.qty) };
    const key = keyOf(line);
    const held = merged.get(key);
    merged.set(key, held ? { ...held, qty: Math.min(MAX_QTY, held.qty + line.qty) } : line);
  }
  return [...merged.values()].slice(0, MAX_LINES).map((line) => Object.freeze(line));
}

export function createCart({ storage = null, storageKey = 'cart', remote = null } = {}) {
  let lines = Object.freeze([]);
  let loaded = null;
  let pushing = Promise.resolve();
  const listeners = new Set();

  const emit = () => listeners.forEach((listener) => listener());

  function persist() {
    if (!storage) return;
    const write = lines.length ? storage.setItem(storageKey, JSON.stringify(lines)) : storage.removeItem(storageKey);
    Promise.resolve(write).catch(() => {});
  }

  /** The server keeps the bag of a signed-in shopper. Changes go one after another, and a failed one is left for the next. */
  function push() {
    if (!remote?.active()) return pushing;
    const sent = lines;
    pushing = pushing.then(() => remote.put(sent)).then(() => undefined, () => undefined);
    return pushing;
  }

  function set(next, { sync = true } = {}) {
    lines = Object.freeze(cleanLines(next));
    persist();
    emit();
    return sync ? push() : Promise.resolve();
  }

  const api = {
    get lines() {
      return lines;
    },
    get count() {
      return lines.reduce((sum, line) => sum + line.qty, 0);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Reads the bag from the device, once. Lines added meanwhile stay. */
    load() {
      loaded ??= (async () => {
        if (!storage) return;
        try {
          const held = cleanLines(JSON.parse((await storage.getItem(storageKey)) ?? 'null'));
          if (held.length) set([...held, ...lines], { sync: false });
        } catch {
          // An unreadable bag is an empty one.
        }
      })();
      return loaded;
    },
    add({ productId, variantId = null, qty = 1 }) {
      if (!whole(productId) || !(variantId === null || whole(variantId)) || !whole(qty)) throw new Error('A line needs a product, a variant or none, and a quantity');
      return set([...lines, { productId, variantId, qty }]);
    },
    setQty(key, qty) {
      if (!Number.isInteger(qty) || qty < 1) return set(lines.filter((line) => keyOf(line) !== key));
      return set(lines.map((line) => (keyOf(line) === key ? { ...line, qty } : line)));
    },
    remove: (key) => set(lines.filter((line) => keyOf(line) !== key)),
    /** The server's own bag after a reorder or a sign-in, which is how today's prices and stock reach the bag. */
    replace: (next, options) => set(next, options),
    clear: () => set([]),
    /** Sign-out and account deletion: nothing stays, here or on the device. Does not touch the server. */
    wipe: () => set([], { sync: false }),
    /** After signing in: the device's bag and the server's are merged by the server, which answers with the result. */
    async mergeWithServer() {
      if (!remote?.active()) return;
      await pushing;
      const answer = await remote.put(lines);
      if (answer) set(answer, { sync: false });
    },
  };
  return Object.freeze(api);
}
