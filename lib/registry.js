/**
 * Items recently sent to the browser or the analyst, by kind and id, so the
 * analyst can open a panel for something an earlier tool call returned.
 */
export function createRegistry({ max = 10_000 } = {}) {
  const items = new Map();
  const key = (kind, id) => `${kind}:${id}`;
  return {
    add(item) {
      if (!item?.kind || item.id == null) return;
      const k = key(item.kind, item.id);
      items.delete(k);
      items.set(k, item);
      if (items.size > max) items.delete(items.keys().next().value);
    },
    addAll(list) {
      for (const item of list || []) this.add(item);
    },
    get: (kind, id) => items.get(key(kind, id)) ?? null,
  };
}
