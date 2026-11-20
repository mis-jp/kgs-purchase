/**
 * Prevent Acumatica API inactivity auto-logout from killing auto-sync.
 *
 * Strategy:
 * 1. Every few minutes, hit a tiny StockItem read with the system cookie.
 * 2. Success → extend our local warm window (session stays active in Acumatica too).
 * 3. 401 → silently re-login with ACU_* credentials and keep the new cookie.
 * 4. Login-limit / no credentials → keep the last cookie and try again next tick.
 *
 * Starts once per Node process (PM2 / next start / next dev).
 */
import { getAcumaticaBaseUrl } from "@/lib/acumatica-env";
import {
    getCachedSystemCredential,
    rememberSystemCredential,
    touchSystemCredential,
} from "@/lib/acumatica-system-auth";
import {
    hasSystemAcumaticaCredentials,
    systemLoginForCompany,
} from "@/lib/sync-acumatica-auth";
import { AuthService } from "@/services/auth";

/** Default: 1 minute — well under typical Acumatica inactivity windows (10–20+ min). */
export const DEFAULT_KEEPALIVE_MS = 60 * 1000;

const shared =
    globalThis.__kgs_acu_keepalive__ ??
    (globalThis.__kgs_acu_keepalive__ = {
        started: false,
        timer: null,
        running: false,
        intervalMs: DEFAULT_KEEPALIVE_MS,
        lastPingAt: null,
        lastOkAt: null,
        lastError: null,
        consecutiveFailures: 0,
        pings: 0,
        relogins: 0,
    });

function resolveIntervalMs() {
    const raw = Number(process.env.ACUMATICA_KEEPALIVE_MS);
    if (Number.isFinite(raw) && raw >= 60_000) return Math.floor(raw);
    return DEFAULT_KEEPALIVE_MS;
}

function keepaliveDisabled() {
    const flag = String(process.env.ACUMATICA_KEEPALIVE || "1").trim().toLowerCase();
    return flag === "0" || flag === "false" || flag === "off" || flag === "no";
}

async function ensureLoggedIn() {
    const existing = getCachedSystemCredential({ allowStale: true });
    if (existing) return existing;
    if (!hasSystemAcumaticaCredentials()) return null;
    return systemLoginForCompany();
}

/**
 * One keep-alive tick. Exported for tests.
 * @returns {Promise<{ ok: boolean, action: string, detail?: string }>}
 */
export async function pingAcumaticaSession() {
    if (!hasSystemAcumaticaCredentials()) {
        return { ok: false, action: "skip", detail: "no-credentials" };
    }

    try {
        getAcumaticaBaseUrl();
    } catch (err) {
        return { ok: false, action: "skip", detail: err.message };
    }

    let cookie = await ensureLoggedIn();
    if (!cookie) {
        return { ok: false, action: "skip", detail: "no-session" };
    }

    let probe = await AuthService.validateSession(cookie);

    if (!probe.ok && probe.reason === "acumatica_expired") {
        // Cookie died from inactivity — re-login before the next sync needs it.
        // Do not clear the old cookie until a new login succeeds (login-limit safety).
        try {
            cookie = await systemLoginForCompany(undefined, { forceRefresh: true });
            shared.relogins += 1;
            rememberSystemCredential(cookie);
            probe = await AuthService.validateSession(cookie);
            if (probe.ok) {
                touchSystemCredential();
                return { ok: true, action: "relogin" };
            }
            return {
                ok: false,
                action: "relogin-failed",
                detail: probe.reason || `status-${probe.status || "?"}`,
            };
        } catch (err) {
            // Login limit: keep whatever stale cookie we still have.
            const kept = getCachedSystemCredential({ allowStale: true });
            if (kept) {
                touchSystemCredential();
                return { ok: true, action: "kept-stale", detail: err.message };
            }
            return { ok: false, action: "relogin-error", detail: err.message };
        }
    }

    if (probe.ok) {
        touchSystemCredential();
        return { ok: true, action: probe.degraded ? "ping-degraded" : "ping" };
    }

    return {
        ok: false,
        action: "ping-failed",
        detail: probe.reason || `status-${probe.status || "?"}`,
    };
}

async function tick() {
    if (shared.running) return;
    shared.running = true;
    shared.lastPingAt = Date.now();
    shared.pings += 1;
    try {
        const result = await pingAcumaticaSession();
        if (result.ok) {
            shared.lastOkAt = Date.now();
            shared.lastError = null;
            shared.consecutiveFailures = 0;
            if (result.action === "relogin") {
                console.log("[AcuKeepAlive] Session expired — re-logged in and session is warm again.");
            }
        } else if (result.action !== "skip") {
            shared.consecutiveFailures += 1;
            shared.lastError = `${result.action}: ${result.detail || ""}`.trim();
            if (shared.consecutiveFailures === 1 || shared.consecutiveFailures % 6 === 0) {
                console.warn(`[AcuKeepAlive] ${shared.lastError}`);
            }
        }
    } catch (err) {
        shared.consecutiveFailures += 1;
        shared.lastError = String(err?.message || err);
        console.warn("[AcuKeepAlive] Unexpected error:", shared.lastError);
    } finally {
        shared.running = false;
    }
}

/**
 * Start the background heartbeat (idempotent). Safe to call from instrumentation
 * and from sync bootstrap.
 */
export function ensureAcumaticaKeepAlive() {
    if (keepaliveDisabled()) return shared;
    if (shared.started) return shared;

    shared.started = true;
    shared.intervalMs = resolveIntervalMs();

    // First ping shortly after boot so the first auto-sync already has a warm session.
    const initialDelay = Math.min(15_000, shared.intervalMs);
    setTimeout(() => {
        tick().catch(() => {});
    }, initialDelay);

    shared.timer = setInterval(() => {
        tick().catch(() => {});
    }, shared.intervalMs);

    if (typeof shared.timer.unref === "function") {
        shared.timer.unref();
    }

    const secs = Math.round(shared.intervalMs / 1000);
    console.log(
        `[AcuKeepAlive] Started — ping every ${secs < 60 ? `${secs}s` : `${Math.round(secs / 60)} min`} to prevent Acumatica inactivity logout.`
    );
    return shared;
}

export function getAcumaticaKeepAliveStatus() {
    return {
        enabled: !keepaliveDisabled(),
        started: shared.started,
        intervalMs: shared.intervalMs,
        lastPingAt: shared.lastPingAt ? new Date(shared.lastPingAt).toISOString() : null,
        lastOkAt: shared.lastOkAt ? new Date(shared.lastOkAt).toISOString() : null,
        lastError: shared.lastError,
        consecutiveFailures: shared.consecutiveFailures,
        pings: shared.pings,
        relogins: shared.relogins,
        hasCachedSession: Boolean(getCachedSystemCredential({ allowStale: true })),
    };
}

/** Test helper — stop the timer without clearing session state. */
export function stopAcumaticaKeepAliveForTests() {
    if (shared.timer) {
        clearInterval(shared.timer);
        shared.timer = null;
    }
    shared.started = false;
    shared.running = false;
}
