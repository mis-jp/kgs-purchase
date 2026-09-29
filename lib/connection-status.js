"use client";

/** Dispatched on window when connectivity state changes. */
export const CONNECTION_STATUS_EVENT = "kgs-connection-status";

export const CONNECTION_KIND = {
    OK: "ok",
    INTERNET: "internet",
    SERVER: "server",
};

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
export async function reportServerDownIfUnhealthy(detail = "api_failure") {
    if (typeof window === "undefined") return false;
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
        reportInternetDown(detail);
        return true;
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    try {
        const { withBasePath } = await import("@/lib/base-path");
        const res = await fetch(withBasePath("/api/health"), {
            method: "GET",
            cache: "no-store",
            credentials: "include",
            signal: ctrl.signal,
        });
        if (!res.ok) {
            reportServerDown(detail);
            return true;
        }
        const data = await res.json().catch(() => ({}));
        if (data?.ok === false || data?.database === false) {
            reportServerDown(detail);
            return true;
        }
        reportConnectionOk();
        return false;
    } catch {
        if (typeof navigator !== "undefined" && navigator.onLine === false) {
            reportInternetDown(detail);
            return true;
        }
        reportServerDown(detail);
        return true;
    } finally {
        clearTimeout(timer);
    }
}
