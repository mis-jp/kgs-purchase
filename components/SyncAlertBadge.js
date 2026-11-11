"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { fetchWithAuth } from "@/lib/api-client";

const POLL_MS = 5 * 60_000;

/** Sidebar warning, for users allowed to see sync alerts, when a sync step or background job keeps failing, or data goes stale. */
export default function SyncAlertBadge({ enabled, collapsed }) {
    const [alerts, setAlerts] = useState([]);

    useEffect(() => {
        if (!enabled) return undefined;
        let active = true;
        const check = () => {
            if (document.hidden) return;
            fetchWithAuth("/api/admin/sync-status?view=alerts")
                .then((res) => (res.ok ? res.json() : null))
                .then((data) => {
                    if (active && data) setAlerts(Array.isArray(data.alerts) ? data.alerts : []);
                })
                .catch(() => {});
        };
        Promise.resolve().then(check);
        const timer = setInterval(check, POLL_MS);
        document.addEventListener("visibilitychange", check);
        return () => {
            active = false;
            clearInterval(timer);
            document.removeEventListener("visibilitychange", check);
        };
    }, [enabled]);

    if (!enabled || !alerts.length) return null;

    const label = alerts.length === 1 ? "1 sync problem" : `${alerts.length} sync problems`;
    return (
        <Link
            href="/admin#sync-health"
            className="sidebar-sync-alert"
            title={alerts.map((a) => a.title).join("\n")}
            aria-label={`${label}. Open Sync health`}
        >
            <span className="sidebar-sync-alert-dot" aria-hidden="true">!</span>
            {!collapsed && <span>{label}</span>}
        </Link>
    );
}
