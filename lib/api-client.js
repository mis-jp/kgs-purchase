"use client";

import { withBasePath } from "@/lib/base-path";
import {
    reportInternetDown,
    reportServerDownIfUnhealthy,
} from "@/lib/connection-status";

/**
 * Client-side API client that automatically includes the session token
 * from localStorage in the Authorization header.
 * Does not auto-logout on 401 — sessions end only via Logout.
 */
export async function fetchWithAuth(url, options = {}) {
    const sessionId = localStorage.getItem("acu_session");
    const headers = {
        ...options.headers,
    };

    if (sessionId) {
        headers["Authorization"] = `Bearer ${sessionId}`;
    }

    const resolvedUrl =
        typeof url === "string" && url.startsWith("/") ? withBasePath(url) : url;

    try {
        const response = await fetch(resolvedUrl, {
            ...options,
            headers,
            cache: "no-store",
            credentials: options.credentials || "include",
        });

        // Only raise the blocking connection modal when health confirms the
        // local app/DB is down. Upstream ERP 503/429 must not trigger it.
        if (
            response.status === 503 &&
            typeof resolvedUrl === "string" &&
            !resolvedUrl.includes("/api/health")
        ) {
            void reportServerDownIfUnhealthy("api_503");
        }

        return response;
    } catch (err) {
        const aborted =
            err?.name === "AbortError" ||
            String(err?.message || "").toLowerCase().includes("abort");
        if (!aborted) {
            console.error(`[API Client Error] ${resolvedUrl}:`, err.message);
            if (typeof navigator !== "undefined" && navigator.onLine === false) {
                reportInternetDown("fetch_offline");
            } else {
                void reportServerDownIfUnhealthy("fetch_failed");
            }
        }
        throw err;
    }
}
