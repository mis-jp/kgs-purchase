"use client";

import { useEffect, useState } from "react";
import { fetchWithAuth } from "@/lib/api-client";

const INTERVAL_MS = 30000;

/**
 * Pull purchase orders Acumatica changed into MySQL every 30 seconds while the
 * tab is visible (and when it becomes visible again). Returns a counter that
 * goes up after each pull so the page can re-read its MySQL data quietly.
 * The server shares one in-flight pull across tabs.
 */
export function usePoLiveRefresh() {
    const [tick, setTick] = useState(0);

    useEffect(() => {
        let cancelled = false;
        let timer = null;
        let running = false;

        const schedule = () => {
            if (timer) clearTimeout(timer);
            if (!cancelled) timer = setTimeout(pull, INTERVAL_MS);
        };

        const pull = async () => {
            if (cancelled || running) return;
            if (typeof document !== "undefined" && document.visibilityState === "hidden") {
                schedule();
                return;
            }
            running = true;
            try {
                await fetchWithAuth("/api/po/live", { method: "POST" });
            } catch {
                /* MySQL data stays on screen */
            } finally {
                running = false;
                if (!cancelled) setTick((t) => t + 1);
                schedule();
            }
        };

        const onVisible = () => {
            if (document.visibilityState === "visible") pull();
        };

        pull();
        document.addEventListener("visibilitychange", onVisible);
        return () => {
            cancelled = true;
            if (timer) clearTimeout(timer);
            document.removeEventListener("visibilitychange", onVisible);
        };
    }, []);

    return tick;
}
