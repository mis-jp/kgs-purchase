"use client";

import { useEffect, useRef } from "react";
import { fetchWithAuth } from "@/lib/api-client";
import { reportAutoSyncStatus } from "@/lib/auto-sync-status";
import {
    QUICK_SYNC_MIN_GAP_MS,
    readLastQuickSyncAt,
    shouldSkipQuickSync,
    writeLastQuickSyncAt,
} from "@/lib/auto-sync-throttle";

const INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const INITIAL_DELAY_MS = 45 * 1000;
const FULL_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const LOCK_KEY = "acu_auto_sync_lock";
const LOCK_TTL_MS = 9 * 60 * 1000;
const FULL_SYNC_KEY = "acu_full_sync_last_run";
const QUICK_SYNC_KEY = "acu_last_quick_sync";

/**
 * While anyone is signed in (user or admin), quietly run Quick Sync (incremental)
 * so MySQL stays current with Acumatica. Server 409 prevents overlapping runs.
 */
export default function BackgroundIncrementalSync() {
    const runningRef = useRef(false);

    useEffect(() => {
        if (typeof window === "undefined") return;

        const path = window.location.pathname || "";
        if (path.includes("/signin") || path.includes("/syncing")) return;

        let cancelled = false;
        let intervalId = null;
        let initialTimer = null;

        const hasSession = () => Boolean(localStorage.getItem("acu_session"));

        const acquireLock = () => {
            const now = Date.now();
            try {
                const raw = localStorage.getItem(LOCK_KEY);
                if (raw) {
                    const lock = JSON.parse(raw);
                    if (lock?.ts && now - Number(lock.ts) < LOCK_TTL_MS) {
                        return false;
                    }
                }
                localStorage.setItem(
                    LOCK_KEY,
                    JSON.stringify({ ts: now, owner: Math.random().toString(36).slice(2) })
                );
                return true;
            } catch {
                return true;
            }
        };

        const drainStream = async (res) => {
            if (!res.body) return { ok: res.ok, message: null };
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            let message = null;
            let failed = false;
            let lastProgress = 0;

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() || "";
                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const data = JSON.parse(line);
                        if (data.ping) continue;
                        const p = Number(data.progress);
                        if (Number.isFinite(p)) lastProgress = p;
                        if (data.section || Number.isFinite(p)) {
                            reportAutoSyncStatus({
                                running: true,
                                progress: lastProgress,
                                section: data.section || "",
                            });
                        }
                        if (data.status === "error") {
                            failed = true;
                            message = data.message || "Sync error";
                        }
                        if (data.status === "complete") {
                            message = data.message || "ok";
                            lastProgress = 100;
                            reportAutoSyncStatus({ running: true, progress: 100, section: data.section || "" });
                        }
                    } catch {
                        /* partial NDJSON line */
                    }
                }
            }
            return { ok: res.ok && !failed, message };
        };

        const runFullSyncIfNeeded = async () => {
            try {
                const now = Date.now();
                const raw = localStorage.getItem(FULL_SYNC_KEY);
                if (raw) {
                    const last = Number(JSON.parse(raw)?.ts || 0);
                    if (Number.isFinite(last) && now - last < FULL_SYNC_INTERVAL_MS) {
                        return;
                    }
                }
                localStorage.setItem(FULL_SYNC_KEY, JSON.stringify({ ts: now }));
                reportAutoSyncStatus({ running: true, progress: 16, section: "Full validation sync" });
                console.log("[AutoSync] Running full validation sync for complete coverage.");
                const res = await fetchWithAuth("/api/sync?inventory=true&sales=true&mode=full", { method: "POST" });
                if (res.ok) {
                    const result = await drainStream(res);
                    if (result.ok) {
                        console.log("[AutoSync] Full validation sync finished.", result.message || "");
                    }
                }
            } catch (err) {
                console.warn("[AutoSync] Full validation sync skipped:", err?.message || err);
            }
        };

        const runQuickSync = async (reason) => {
            if (cancelled || runningRef.current) return;
            if (!hasSession()) return;
            if (document.visibilityState === "hidden") return;

            const now = Date.now();
            const lastSyncAt = readLastQuickSyncAt(localStorage, QUICK_SYNC_KEY);
            if (shouldSkipQuickSync(now, lastSyncAt, QUICK_SYNC_MIN_GAP_MS)) {
                console.log(`[AutoSync] Skipped Quick Sync (${reason}) — last run was too recent.`);
                return;
            }
            if (!acquireLock()) return;

            runningRef.current = true;
            reportAutoSyncStatus({ running: true, progress: 4, section: "Quick Sync" });
            try {
                console.log(`[AutoSync] Starting Quick Sync (${reason})…`);
                writeLastQuickSyncAt(localStorage, QUICK_SYNC_KEY, now);
                const res = await fetchWithAuth(
                    "/api/sync?inventory=true&sales=true&mode=incremental",
                    { method: "POST" }
                );

                if (res.status === 409) {
                    console.log("[AutoSync] Skipped — another sync is already running.");
                    reportAutoSyncStatus({ running: true, progress: 8, section: "Syncing" });
                    return;
                }
                if (res.status === 401) {
                    console.warn("[AutoSync] Unauthorized — pausing auto-sync until next cycle.");
                    reportAutoSyncStatus({ running: false, progress: 0 });
                    return;
                }

                const result = await drainStream(res);
                if (result.ok) {
                    console.log("[AutoSync] Quick Sync finished.", result.message || "");
                    if (reason === "online" || reason === "visible") {
                        await runFullSyncIfNeeded();
                    }
                } else {
                    console.warn("[AutoSync] Quick Sync failed:", result.message || res.status);
                }
            } catch (err) {
                console.warn("[AutoSync] Error:", err?.message || err);
            } finally {
                runningRef.current = false;
                reportAutoSyncStatus({ running: false, progress: 0 });
            }
        };

        initialTimer = setTimeout(() => {
            runQuickSync("online");
            intervalId = setInterval(() => runQuickSync("interval"), INTERVAL_MS);
        }, INITIAL_DELAY_MS);

        const onVisible = () => {
            if (document.visibilityState === "visible") {
                runQuickSync("visible");
            }
        };
        document.addEventListener("visibilitychange", onVisible);

        return () => {
            cancelled = true;
            if (initialTimer) clearTimeout(initialTimer);
            if (intervalId) clearInterval(intervalId);
            document.removeEventListener("visibilitychange", onVisible);
        };
    }, []);

    return null;
}
