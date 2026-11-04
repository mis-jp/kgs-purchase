/** Waiting rules for Acumatica "too many requests" (HTTP 429) responses. */

export const MAX_BUSY_WAIT_MS = 30_000;

/**
 * How long to wait before retrying a 429.
 * Honors Retry-After (seconds or an HTTP date); otherwise 2s, 4s, 8s, 16s… capped at 30s.
 */
export function busyRetryDelayMs(retryAfter, attempt, now = Date.now()) {
    const raw = String(retryAfter ?? "").trim();
    if (raw) {
        const seconds = Number(raw);
        if (Number.isFinite(seconds) && seconds >= 0) {
            return Math.min(MAX_BUSY_WAIT_MS, Math.round(seconds * 1000));
        }
        const at = Date.parse(raw);
        if (Number.isFinite(at)) {
            return Math.min(MAX_BUSY_WAIT_MS, Math.max(0, at - now));
        }
    }
    const n = Math.max(1, Number(attempt) || 1);
    return Math.min(MAX_BUSY_WAIT_MS, 1000 * 2 ** n);
}

/** True when an error came from Acumatica refusing the credential. */
export function isAcumaticaUnauthorized(err) {
    return /^Unauthorized$/i.test(String(err?.message || "").trim());
}

/** True when an error came from Acumatica being busy (rate limit). */
export function isAcumaticaBusy(err) {
    return /\bHTTP 429\b|too many requests/i.test(String(err?.message || ""));
}
