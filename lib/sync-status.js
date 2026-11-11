/** Pure helpers behind the admin Sync health panel. */
import { redactSecrets } from "./redact-secrets.js";

const HOUR_MS = 60 * 60 * 1000;

/** How old each data set may get before it is flagged. */
export const FRESHNESS_LIMITS = {
    inventory: { warnMs: 6 * HOUR_MS, alertMs: 24 * HOUR_MS },
    sales: { warnMs: 6 * HOUR_MS, alertMs: 24 * HOUR_MS },
    purchaseOrders: { warnMs: 2 * HOUR_MS, alertMs: 12 * HOUR_MS },
};

function toMs(value) {
    if (value == null || value === "") return null;
    const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
    return Number.isFinite(ms) ? ms : null;
}

function toIso(value) {
    const ms = toMs(value);
    return ms == null ? null : new Date(ms).toISOString();
}

/** "ok" | "warn" | "alert" | "unknown" for a last-sync timestamp. */
export function freshnessLevel(lastSync, { warnMs, alertMs }, now = Date.now()) {
    const ms = toMs(lastSync);
    if (ms == null) return "unknown";
    const age = now - ms;
    if (age >= alertMs) return "alert";
    if (age >= warnMs) return "warn";
    return "ok";
}

export function describeFreshness(key, label, lastSync, now = Date.now()) {
    const ms = toMs(lastSync);
    return {
        key,
        label,
        lastSync: toIso(lastSync),
        ageMs: ms == null ? null : Math.max(0, now - ms),
        level: freshnessLevel(lastSync, FRESHNESS_LIMITS[key], now),
    };
}

/**
 * Collapse recent sync_logs rows (newest first) into one entry per section:
 * the latest status, the last success, and the last error message.
 */
export function summarizeSyncLogs(rows) {
    const bySection = new Map();
    for (const row of rows || []) {
        const section = String(row?.section || "").trim() || "Unknown";
        const status = String(row?.status || "").trim().toLowerCase();
        const at = toIso(row?.timestamp);
        let entry = bySection.get(section);
        if (!entry) {
            entry = {
                section,
                lastStatus: status || "unknown",
                lastRunAt: at,
                lastMode: row?.mode || "",
                lastRecords: Number(row?.records) || 0,
                lastSuccessAt: null,
                lastErrorAt: null,
                lastError: null,
                consecutiveErrors: 0,
            };
            bySection.set(section, entry);
        }
        if (!entry.lastSuccessAt && status === "error") entry.consecutiveErrors += 1;
        if (status === "completed" && !entry.lastSuccessAt) entry.lastSuccessAt = at;
        if (status === "error" && !entry.lastErrorAt) {
            entry.lastErrorAt = at;
            entry.lastError = row?.message ? redactSecrets(String(row.message)).slice(0, 300) : null;
        }
    }
    return [...bySection.values()];
}

/** Failures in a row before a sync step or background job is raised as an alert. */
export const FAILURE_ALERT_THRESHOLD = 3;

/**
 * Problems an admin should act on: steps or jobs failing repeatedly, and data
 * that has gone stale. Each alert: { key, kind, title, detail, since }.
 */
export function buildSyncAlerts({ sections = [], jobs = [], freshness = [] } = {}, threshold = FAILURE_ALERT_THRESHOLD) {
    const alerts = [];
    for (const s of sections) {
        if ((s.consecutiveErrors || 0) < threshold) continue;
        alerts.push({
            key: `section:${s.section}`,
            kind: "sync-step",
            title: `${s.section} sync failed ${s.consecutiveErrors} times in a row`,
            detail: s.lastError || "No error message was recorded.",
            since: s.lastSuccessAt,
        });
    }
    for (const j of jobs) {
        if ((j.consecutiveFailures || 0) < threshold) continue;
        alerts.push({
            key: `job:${j.name}`,
            kind: "background-job",
            title: `Background job failed ${j.consecutiveFailures} times in a row`,
            detail: j.lastError || "No error message was recorded.",
            job: j.name,
            since: null,
        });
    }
    for (const f of freshness) {
        if (f.level !== "alert") continue;
        alerts.push({
            key: `stale:${f.key}`,
            kind: "stale-data",
            title: `${f.label} has not synced for over ${Math.round(FRESHNESS_LIMITS[f.key].alertMs / HOUR_MS)} hours`,
            detail: f.lastSync ? "Check the Syncing Center and the sync steps below." : "No sync recorded",
            since: f.lastSync,
        });
    }
    return alerts;
}
