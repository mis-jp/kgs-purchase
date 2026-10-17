/**
 * Central map from "what data changed" to "which server-cache keys depend on it".
 *
 * Writers call invalidateFor(event, scope) only after their write has committed
 * (or use runAfterCommit, which enforces that). Readers build their keys with
 * cacheKeys so a key format and the prefix that clears it can't drift apart.
 *
 * Invalidation is prefix-based and idempotent: running it twice is harmless.
 * A prefix that fails to clear is logged and retried with backoff; if every retry
 * fails, the entry's own TTL is the upper bound on staleness.
 */
import { invalidateCache } from "./server-cache.js";

function part(value, fallback = "") {
    const text = String(value ?? "").trim();
    return text || fallback;
}

function upper(value, fallback = "") {
    return part(value, fallback).toUpperCase();
}

export const cacheKeys = {
    /** Forecast Generator rows for one company + forecast branch key. */
    forecastRowsPrefix(companyId, branchKey) {
        return `forecast:rows:${part(companyId, "main")}:${upper(branchKey)}:`;
    },
    forecastRows(companyId, branchKey, queryKey) {
        return `${cacheKeys.forecastRowsPrefix(companyId, branchKey)}${queryKey}`;
    },
    forecastSalesGaps(rangeKey) {
        return `forecast:salesGaps:${rangeKey}`;
    },
    /** Replenishment page payloads for one company + branch. */
    replenishmentPagesPrefix(companyId, branchKey) {
        return `replenishment:api:names:${part(companyId, "main")}:${upper(branchKey)}:`;
    },
    replenishmentPage(companyId, branchKey, rest) {
        return `${cacheKeys.replenishmentPagesPrefix(companyId, branchKey)}${rest}`;
    },
    annotations(moduleName) {
        return `annotations:${moduleName}`;
    },
};

const ALL_FORECAST_ROWS = "forecast:rows:";
const ALL_FORECAST_SALES_GAPS = "forecast:salesGaps:";
const ALL_REPLENISHMENT_PAGES = "replenishment:api:names:";

/**
 * event -> (scope) => prefixes. Keep each list to the data the event can change.
 */
const EVENTS = {
    /** Forecast Generator estimate / buffer / target saved for one SKU. */
    "forecast-input.saved": ({ companyId, branchKey } = {}) => [
        cacheKeys.forecastRowsPrefix(companyId, branchKey),
    ],
    /** forecast_item_stock rows written or purged (sync / repair). */
    "forecast-stock.changed": () => [ALL_FORECAST_ROWS],
    /** purchase_history / purchase_order_details changed (status edit or PO sync). */
    "purchase-orders.changed": () => ["po:", "openPo:", ALL_FORECAST_ROWS, ALL_REPLENISHMENT_PAGES],
    /** PO lines changed in a way that can move the item -> vendor mapping. */
    "purchase-order-lines.changed": () => [
        "itemVendorMap",
        "po:",
        "openPo:",
        ALL_FORECAST_ROWS,
        ALL_REPLENISHMENT_PAGES,
    ],
    /** product_periodic_sales written. */
    "periodic-sales.changed": () => [
        "salesIds:",
        "salesAnalysis:",
        "replSalesMap:",
        "salesBranchNames",
        "resolveSalesBranch:",
        "salesSummary:",
        ALL_FORECAST_ROWS,
        ALL_FORECAST_SALES_GAPS,
    ],
    /** A user annotation (ETA, status, lead time) saved for one module. */
    "annotation.saved": ({ moduleName } = {}) => [cacheKeys.annotations(moduleName)],
    /** item_dimensions row created / updated (single edit or import). */
    "item-dimensions.changed": () => ["stock-items-kpi:"],
    /** replenishment_cache rows rebuilt for one branch. */
    "replenishment.branch-rebuilt": ({ companyId, branchKey } = {}) => [
        cacheKeys.replenishmentPagesPrefix(companyId, branchKey),
    ],
};

export function listInvalidationEvents() {
    return Object.keys(EVENTS);
}

/** Prefixes an event clears, de-duplicated, without touching the cache. */
export function prefixesFor(event, scope = {}) {
    const rule = EVENTS[event];
    if (!rule) throw new Error(`[cache-invalidation] unknown event "${event}"`);
    return [...new Set(rule(scope).filter(Boolean))];
}

const failures = [];
const MAX_FAILURES = 50;

function recordFailure(event, prefix, err) {
    failures.push({ event, prefix, message: String(err?.message || err), at: new Date().toISOString() });
    if (failures.length > MAX_FAILURES) failures.shift();
}

/** Recent invalidations that still failed after every retry (newest last). */
export function getInvalidationFailures() {
    return failures.slice();
}

export function clearInvalidationFailures() {
    failures.length = 0;
}

function defaultSchedule(fn, ms) {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
}

/**
 * Clear every cache prefix that depends on `event`. Call after the write commits.
 * Never throws: a failing prefix is logged and retried in the background.
 *
 * @returns {{ event: string, prefixes: string[], failed: string[] }}
 */
export function invalidateFor(event, scope = {}, options = {}) {
    const {
        invalidate = invalidateCache,
        retries = 3,
        retryDelayMs = 200,
        schedule = defaultSchedule,
        logger = console,
    } = options;

    let prefixes;
    try {
        prefixes = prefixesFor(event, scope);
    } catch (err) {
        logger.error(String(err?.message || err));
        return { event, prefixes: [], failed: [] };
    }

    const failed = [];
    for (const prefix of prefixes) {
        try {
            invalidate(prefix);
        } catch (err) {
            failed.push(prefix);
            logger.warn(`[cache-invalidation] ${event} -> "${prefix}" failed: ${err?.message || err}; retrying`);
            retryPrefix({ event, prefix, invalidate, retries, retryDelayMs, schedule, logger, attempt: 1 });
        }
    }
    return { event, prefixes, failed };
}

function retryPrefix(ctx) {
    const { event, prefix, invalidate, retries, retryDelayMs, schedule, logger, attempt } = ctx;
    if (attempt > retries) return;
    schedule(() => {
        try {
            invalidate(prefix);
            logger.info?.(`[cache-invalidation] ${event} -> "${prefix}" cleared on retry ${attempt}`);
        } catch (err) {
            if (attempt >= retries) {
                recordFailure(event, prefix, err);
                logger.error(
                    `[cache-invalidation] ${event} -> "${prefix}" still failing after ${retries} retries: ` +
                        `${err?.message || err}. Entries expire on their TTL.`
                );
                return;
            }
            retryPrefix({ ...ctx, attempt: attempt + 1 });
        }
    }, retryDelayMs * 2 ** (attempt - 1));
}

/**
 * Run a write, then invalidate only if it resolved. A write that throws (or
 * resolves to `false`, the service-layer "not saved" signal) leaves caches alone.
 */
export async function runAfterCommit(write, event, scope = {}, options = {}) {
    const result = await write();
    if (result === false) return result;
    invalidateFor(event, typeof scope === "function" ? scope(result) : scope, options);
    return result;
}
