/**
 * Lightweight in-memory TTL cache for server-side API hot paths.
 * Tracks hit/miss for performance logging.
 * Concurrent misses for the same key share one in-flight loader.
 */
const store = new Map();
const inflight = new Map();

const stats = {
    hits: 0,
    misses: 0,
};

export function getCacheStats() {
    const total = stats.hits + stats.misses;
    return {
        hits: stats.hits,
        misses: stats.misses,
        hitRate: total ? Number((stats.hits / total).toFixed(3)) : 0,
        size: store.size,
        inflight: inflight.size,
    };
}

export function resetCacheStats() {
    stats.hits = 0;
    stats.misses = 0;
}

export function getCached(key, ttlMs, loader) {
    const hit = store.get(key);
    if (hit && Date.now() - hit.ts < ttlMs) {
        stats.hits += 1;
        return Promise.resolve(hit.value);
    }

    const pending = inflight.get(key);
    if (pending) {
        stats.hits += 1;
        return pending;
    }

    stats.misses += 1;
    const loadPromise = Promise.resolve()
        .then(() => loader())
        .then((value) => {
            // Don't poison the cache with empty/null results
            if (value !== null && value !== undefined) {
                store.set(key, { ts: Date.now(), value });
            }
            return value;
        })
        .finally(() => {
            inflight.delete(key);
        });

    inflight.set(key, loadPromise);
    return loadPromise;
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

export function invalidateCache(prefix) {
    for (const key of store.keys()) {
        if (key.startsWith(prefix)) store.delete(key);
    }
    for (const key of inflight.keys()) {
        if (key.startsWith(prefix)) inflight.delete(key);
    }
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
