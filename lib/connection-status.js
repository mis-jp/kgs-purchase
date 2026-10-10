"use client";

/** Dispatched on window when connectivity state changes. */
export const CONNECTION_STATUS_EVENT = "kgs-connection-status";

export const CONNECTION_KIND = {
    OK: "ok",
    INTERNET: "internet",
    SLOW: "slow",
    SERVER: "server",
};

const HEALTH_PROBE_TIMEOUT_MS = 12_000;
const SLOW_STRIKES_BEFORE_WARNING = 2;

let slowStreak = 0;

function noteSlowProbe() {
    slowStreak += 1;
    return slowStreak;
}

function resetSlowStreak() {
    slowStreak = 0;
}

function isAbortError(err) {
    return err?.name === "AbortError" || /abort/i.test(String(err?.message || ""));
}

/**
 * Ask /api/health and classify the result.
 * A slow or timed-out check is a weak connection. The server warning is
 * only for a completed answer that says the database is unreachable,
 * or for an immediate refusal while this browser is still online.
 */
export async function probeAppHealth(timeoutMs = HEALTH_PROBE_TIMEOUT_MS) {
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
        resetSlowStreak();
        return CONNECTION_KIND.INTERNET;
    }

    const started = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const { withBasePath } = await import("@/lib/base-path");
        const res = await fetch(withBasePath("/api/health"), {
            method: "GET",
            cache: "no-store",
            credentials: "include",
            signal: ctrl.signal,
        });
        const data = await res.json().catch(() => ({}));
        if (data?.reason === "slow" || data?.slow === true) {
            return noteSlowProbe() >= SLOW_STRIKES_BEFORE_WARNING
                ? CONNECTION_KIND.SLOW
                : CONNECTION_KIND.OK;
        }
        if (!res.ok || data?.ok === false || data?.database === false) {
            resetSlowStreak();
            return CONNECTION_KIND.SERVER;
        }
        resetSlowStreak();
        return CONNECTION_KIND.OK;
    } catch (err) {
        if (typeof navigator !== "undefined" && navigator.onLine === false) {
            resetSlowStreak();
            return CONNECTION_KIND.INTERNET;
        }
        const elapsed = Date.now() - started;
        if (isAbortError(err) || elapsed >= 2500) {
            return noteSlowProbe() >= SLOW_STRIKES_BEFORE_WARNING
                ? CONNECTION_KIND.SLOW
                : CONNECTION_KIND.OK;
        }
        resetSlowStreak();
        return CONNECTION_KIND.SERVER;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * @param {"ok"|"internet"|"server"} kind
 * @param {{ detail?: string }} [extra]
 */
export function reportConnectionStatus(kind, extra = {}) {
    if (typeof window === "undefined") return;
    try {
        window.dispatchEvent(
            new CustomEvent(CONNECTION_STATUS_EVENT, {
                detail: { kind, at: Date.now(), ...extra },
            })
        );
    } catch {
        /* ignore */
    }
}

export function reportInternetDown(detail) {
    reportConnectionStatus(CONNECTION_KIND.INTERNET, { detail });
}

export function reportServerDown(detail) {
    reportConnectionStatus(CONNECTION_KIND.SERVER, { detail });
}

export function reportConnectionOk() {
    reportConnectionStatus(CONNECTION_KIND.OK);
}

/**
 * Confirm the app/database is actually unreachable before showing the
 * blocking "Unable to reach the server" modal. Upstream ERP 503/429s must
 * not look like a local outage.
 *
 * @param {string} [detail]
 * @returns {Promise<boolean>} true when health confirms the server is down
 */
export function reportSlowConnection(detail) {
    reportConnectionStatus(CONNECTION_KIND.SLOW, { detail });
}

export async function reportServerDownIfUnhealthy(detail = "api_failure") {
    if (typeof window === "undefined") return false;
    const kind = await probeAppHealth();
    if (kind === CONNECTION_KIND.INTERNET) {
        reportInternetDown(detail);
        return true;
    }
    if (kind === CONNECTION_KIND.SLOW) {
        reportSlowConnection(detail);
        return true;
    }
    if (kind === CONNECTION_KIND.SERVER) {
        reportServerDown(detail);
        return true;
    }
    reportConnectionOk();
    return false;
}
