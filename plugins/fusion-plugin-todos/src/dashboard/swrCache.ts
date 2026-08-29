export const SWR_CACHE_KEYS = { TODO_LISTS_PREFIX: "fusion:todos:" };
export const SWR_DEFAULT_MAX_AGE_MS = 60_000;
type Entry<T> = { value: T; at: number };
const cache = new Map<string, Entry<unknown>>();
export function readCache<T>(key: string, options: { maxAgeMs: number }): T | null { const hit = cache.get(key) as Entry<T> | undefined; return hit && Date.now() - hit.at <= options.maxAgeMs ? hit.value : null; }
export function writeCache<T>(key: string, value: T, _options?: { maxBytes?: number }): void { cache.set(key, { value, at: Date.now() }); }
