/** An in-memory SecureStore for tests. `__reset()` empties it; `__dump()` shows what is held. */
let items = new Map();
const key = (name) => {
  if (typeof name !== 'string' || !/^[\w.-]+$/.test(name)) throw new Error(`Invalid SecureStore key "${name}"`);
  return name;
};
module.exports = {
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY',
  isAvailableAsync: async () => true,
  canUseBiometricAuthentication: () => true,
  getItemAsync: async (name) => items.get(key(name)) ?? null,
  setItemAsync: async (name, value, options) => {
    if (typeof value !== 'string') throw new Error('SecureStore holds strings only');
    items.set(key(name), value);
    module.exports.__options.set(name, options ?? {});
  },
  deleteItemAsync: async (name) => {
    items.delete(key(name));
  },
  __options: new Map(),
  __reset: () => {
    items = new Map();
    module.exports.__options.clear();
  },
  __dump: () => Object.fromEntries(items),
};
