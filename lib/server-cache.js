/**
 * Lightweight in-memory TTL cache for server-side API hot paths.
 * Tracks hit/miss for performance logging.
 * Concurrent misses for the same key share one in-flight loader.
 *
 * Invalidation is safe against in-flight loads: a loader that started before
 * invalidateCache() ran may have read pre-write rows, so its result is returned
 * to the callers already waiting on it but is never written back to the cache.
 *
 * State lives on globalThis (same convention as lib/session-store.js) so every
 * route bundle in the PM2 process shares one cache and one invalidation path.
 */
const shared =
    globalThis.__kgs_server_cache__ ??
    (globalThis.__kgs_server_cache__ = {
        store: new Map(),
        inflight: new Map(),
        stats: { hits: 0, misses: 0, invalidations: 0, discardedStaleLoads: 0 },
    });
const { store, inflight, stats } = shared;

export function cacheIsFresh(cached, ttlMs, now = Date.now()) {
    if (!cached || !Number.isFinite(cached.ts) || !Number.isFinite(ttlMs)) {
        return false;
    }
    return now - cached.ts < ttlMs;
}

export function getCacheStats() {
    const total = stats.hits + stats.misses;
    return {
        hits: stats.hits,
        misses: stats.misses,
        hitRate: total ? Number((stats.hits / total).toFixed(3)) : 0,
        size: store.size,
        inflight: inflight.size,
        invalidations: stats.invalidations,
        discardedStaleLoads: stats.discardedStaleLoads,
    };
}

export function resetCacheStats() {
    stats.hits = 0;
    stats.misses = 0;
    stats.invalidations = 0;
    stats.discardedStaleLoads = 0;
}

export function getCached(key, ttlMs, loader) {
    const hit = store.get(key);
    if (hit && cacheIsFresh(hit, ttlMs, Date.now())) {
        stats.hits += 1;
        return Promise.resolve(hit.value);
    }

    const pending = inflight.get(key);
    if (pending) {
        stats.hits += 1;
        return pending.promise;
    }

    stats.misses += 1;
    const entry = { promise: null, invalidated: false };
    entry.promise = Promise.resolve()
        .then(() => loader())
        .then((value) => {
            if (entry.invalidated) {
                // A write committed while this load was running; its rows may be stale.
                stats.discardedStaleLoads += 1;
                return value;
            }
            // Don't poison the cache with empty/null results
            if (value !== null && value !== undefined) {
                store.set(key, { ts: Date.now(), value });
            }
            return value;
        })
        .finally(() => {
            // Only clear our own entry; a newer load may already own the key.
            if (inflight.get(key) === entry) inflight.delete(key);
        });

    inflight.set(key, entry);
    return entry.promise;
}

/**
 * Start a cached loader without awaiting it. Safe for request paths that must
 * stay fast even when maintenance work is slow or cold.
 */
export function kickCached(key, ttlMs, loader) {
    const hit = store.get(key);
    if (hit && Date.now() - hit.ts < ttlMs) return;
    if (inflight.has(key)) return;
    void getCached(key, ttlMs, loader).catch((err) => {
        console.error(`[cache:${key}]`, err?.message || err);
    });
}

/**
 * Drop every cached entry whose key starts with `prefix`, and stop any matching
 * in-flight load from writing its (possibly pre-write) result back.
 * Idempotent: repeating it only drops keys that were re-cached since.
 * Returns the number of cached entries removed.
 */
export function invalidateCache(prefix) {
    let removed = 0;
    for (const key of store.keys()) {
        if (key.startsWith(prefix)) {
            store.delete(key);
            removed += 1;
        }
    }
    for (const [key, entry] of inflight) {
        if (key.startsWith(prefix)) {
            entry.invalidated = true;
            inflight.delete(key);
        }
    }
    stats.invalidations += 1;
    return removed;
}

/** Log slow async work (SQL loaders, aggregations). Threshold default 100ms. */
export async function timed(label, fn, thresholdMs = 100) {
    const start = Date.now();
    try {
        return await fn();
    } finally {
        const ms = Date.now() - start;
        if (ms >= thresholdMs) {
            console.warn(`[Slow] ${label} took ${ms}ms`);
        }
    }
}
