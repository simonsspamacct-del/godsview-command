/**
 * A small time-to-live cache. Concurrent requests for the same key share one
 * load, and a failed load is not cached.
 */
export function createCache({ ttlMs, max = 500 }) {
  const entries = new Map();
  const pending = new Map();

  const fresh = (entry) => entry && entry.expires > Date.now();

  return {
    async get(key, load) {
      const entry = entries.get(key);
      if (fresh(entry)) return entry.value;
      if (pending.has(key)) return pending.get(key);
      const promise = (async () => {
        try {
          const value = await load();
          entries.delete(key);
          entries.set(key, { value, expires: Date.now() + ttlMs });
          while (entries.size > max) entries.delete(entries.keys().next().value);
          return value;
        } finally {
          pending.delete(key);
        }
      })();
      pending.set(key, promise);
      return promise;
    },
    peek(key) {
      const entry = entries.get(key);
      return fresh(entry) ? entry.value : undefined;
    },
    clear() {
      entries.clear();
    },
  };
}
