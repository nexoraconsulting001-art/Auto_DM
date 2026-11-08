/**
 * A small key-value cache. One interface, two drivers (CACHE_DRIVER):
 *   memory  per process (QA, one web server)
 *   redis   shared by every server (production)
 * Values are JSON. Keys for business data must include the business id.
 *
 *   get(key) -> value | null    set(key, value, ttlSeconds)    del(key)    close()
 */
export function createCache(config = {}) {
  const driver = config.cacheDriver || 'memory';
  if (driver === 'memory') return memoryCache();
  if (driver === 'redis') return redisCache(config);
  throw new Error(`Unknown CACHE_DRIVER "${driver}" (use memory or redis)`);
}

function memoryCache({ maxEntries = 10_000 } = {}) {
  const map = new Map();
  return {
    driver: 'memory',
    async get(key) {
      const hit = map.get(key);
      if (!hit) return null;
      if (hit.exp < Date.now()) {
        map.delete(key);
        return null;
      }
      return hit.value;
    },
    async set(key, value, ttlSeconds = 60) {
      if (map.size >= maxEntries) map.delete(map.keys().next().value);
      map.set(key, { value: JSON.parse(JSON.stringify(value)), exp: Date.now() + ttlSeconds * 1000 });
    },
    async del(key) {
      map.delete(key);
    },
    async close() {},
  };
}

function redisCache(config) {
  if (!config.redisUrl) throw new Error('REDIS_URL is required when CACHE_DRIVER=redis');
  let clientPromise;
  const client = () => (clientPromise ??= import('ioredis').then(({ default: Redis }) => new Redis(config.redisUrl, { lazyConnect: false })));
  const prefix = 'cache:';
  return {
    driver: 'redis',
    async get(key) {
      const raw = await (await client()).get(prefix + key);
      return raw == null ? null : JSON.parse(raw);
    },
    async set(key, value, ttlSeconds = 60) {
      await (await client()).set(prefix + key, JSON.stringify(value), 'EX', Math.max(1, Math.round(ttlSeconds)));
    },
    async del(key) {
      await (await client()).del(prefix + key);
    },
    async close() {
      if (clientPromise) (await client()).disconnect();
    },
  };
}
