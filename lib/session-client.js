"use client";

import { withBasePath } from "@/lib/base-path";
import { SESSION_EXPIRED_MESSAGE } from "@/lib/session-messages";

export { SESSION_EXPIRED_MESSAGE };
export const SESSION_STATUS_EVENT = "acu-session-status";

const AUTH_PROBE_PATHS = ["/api/auth/login", "/api/auth/logout", "/api/auth/session"];

export function isAuthProbeUrl(url) {
    const path = typeof url === "string" ? url : "";
    return AUTH_PROBE_PATHS.some((p) => path.includes(p));
}

export function emitSessionStatus(detail) {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent(SESSION_STATUS_EVENT, { detail }));
}

/**
 * Explicit sign-out helper (sidebar Logout). Do not call from automatic probes.
 */
export function handleSessionExpired(options = {}) {
    if (typeof window === "undefined") return;

    const message = options.message || SESSION_EXPIRED_MESSAGE;
    const force = options.force === true;

    // Automatic paths must not clear the session — only explicit logout / force
    if (!force) {
        emitSessionStatus({
            authenticated: true,
            expired: false,
            degraded: true,
            message: message || "Connection issue — still signed in.",
        });
        return;
    }

    if (window.__acu_session_expiring) {
        emitSessionStatus({ authenticated: false, expired: true, message });
        return;
    }
    window.__acu_session_expiring = true;

    try {
        localStorage.removeItem("acu_session");
        localStorage.removeItem("userName");
        localStorage.removeItem("userFirstName");
        localStorage.removeItem("userLastName");
        localStorage.removeItem("userRole");
        localStorage.removeItem("userAllBranches");
        localStorage.removeItem("authType");
        localStorage.removeItem("activeCompanyId");
    } catch {
        // ignore storage errors
    }

    emitSessionStatus({ authenticated: false, expired: true, message });
    window.location.href = withBasePath("/api/auth/logout?expired=1");
}

/**
 * Probe session via BFF. Never forces logout — only reports status.
 */
export async function checkSessionStatus() {
    try {
        const res = await fetch(withBasePath("/api/auth/session"), {
            method: "GET",
            credentials: "include",
            cache: "no-store",
            headers: (() => {
                const headers = { Accept: "application/json" };
                try {
                    const sessionId = localStorage.getItem("acu_session");
                    if (sessionId) headers.Authorization = `Bearer ${sessionId}`;
                } catch {
                    // ignore
                }
                return headers;
            })(),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.authenticated === false) {
            // Keep client signed-in UI unless there is no cookie at all
            let hasCookie = false;
            try {
                hasCookie = !!localStorage.getItem("acu_session");
            } catch {
                hasCookie = false;
            }
            if (hasCookie) {
                return {
                    authenticated: true,
                    expired: false,
                    degraded: true,
                    message: data.message || "Session check failed — still signed in.",
                    source: "local",
                };
            }
            return {
                authenticated: false,
                expired: true,
                message: data.message || SESSION_EXPIRED_MESSAGE,
                source: data.source || "local",
            };
        }
        return {
            authenticated: true,
            expired: false,
            activeCompanyId: data.activeCompanyId || "main",
            isBypass: !!data.isBypass,
            source: data.source || "local",
            degraded: !!data.degraded,
            user: data.user || null,
        };
    } catch {
        return {
            authenticated: true,
            expired: false,
            offline: true,
            degraded: true,
        };
    }
}
