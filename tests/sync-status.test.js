import test from "node:test";
import assert from "node:assert/strict";
import { freshnessLevel, describeFreshness, summarizeSyncLogs, buildSyncAlerts } from "../lib/sync-status.js";

test("summarizeSyncLogs counts errors in a row since the last success", () => {
    const [entry] = summarizeSyncLogs([
        { section: "Sales", status: "error", timestamp: "2026-11-10T05:00:00Z", message: "x" },
        { section: "Sales", status: "started", timestamp: "2026-11-10T04:59:00Z" },
        { section: "Sales", status: "error", timestamp: "2026-11-10T04:00:00Z" },
        { section: "Sales", status: "error", timestamp: "2026-11-10T03:00:00Z" },
        { section: "Sales", status: "completed", timestamp: "2026-11-10T02:00:00Z" },
        { section: "Sales", status: "error", timestamp: "2026-11-10T01:00:00Z" },
    ]);
    assert.equal(entry.consecutiveErrors, 3);
    assert.equal(entry.lastSuccessAt, "2026-11-10T02:00:00.000Z");
});

test("buildSyncAlerts raises repeated failures and stale data only", () => {
    const alerts = buildSyncAlerts({
        sections: [
            { section: "Sales", consecutiveErrors: 3, lastError: "timeout", lastSuccessAt: null },
            { section: "Inventory", consecutiveErrors: 2, lastError: "x" },
        ],
        jobs: [
            { name: "job:a", consecutiveFailures: 4, lastError: "locked" },
            { name: "job:b", consecutiveFailures: 1 },
        ],
        freshness: [
            { key: "purchaseOrders", label: "Purchase orders", level: "alert", lastSync: "2026-11-09T00:00:00Z" },
            { key: "sales", label: "Sales history", level: "warn", lastSync: "2026-11-10T00:00:00Z" },
        ],
    });
    assert.deepEqual(alerts.map((a) => a.key), ["section:Sales", "job:job:a", "stale:purchaseOrders"]);
    assert.equal(alerts[0].title, "Sales sync failed 3 times in a row");
    assert.equal(alerts[2].title, "Purchase orders has not synced for over 12 hours");
    assert.deepEqual(buildSyncAlerts({}), []);
});

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-11-04T08:00:00Z");

test("freshnessLevel grades age against warn and alert limits", () => {
    const limits = { warnMs: 2 * HOUR, alertMs: 12 * HOUR };
    assert.equal(freshnessLevel(new Date(NOW - HOUR), limits, NOW), "ok");
    assert.equal(freshnessLevel(new Date(NOW - 3 * HOUR), limits, NOW), "warn");
    assert.equal(freshnessLevel(new Date(NOW - 13 * HOUR), limits, NOW), "alert");
    assert.equal(freshnessLevel(null, limits, NOW), "unknown");
    assert.equal(freshnessLevel("not a date", limits, NOW), "unknown");
});

test("describeFreshness reports ISO time and age", () => {
    const f = describeFreshness("purchaseOrders", "Purchase orders", new Date(NOW - 30 * 60_000), NOW);
    assert.equal(f.level, "ok");
    assert.equal(f.ageMs, 30 * 60_000);
    assert.equal(f.lastSync, new Date(NOW - 30 * 60_000).toISOString());
});

test("summarizeSyncLogs keeps latest status plus last success and last error per section", () => {
    const rows = [
        { timestamp: "2026-11-04T07:00:00Z", section: "Incoming PO", status: "error", records: 0, message: "Unauthorized", mode: "incremental" },
        { timestamp: "2026-11-04T06:00:00Z", section: "Incoming PO", status: "completed", records: 12, mode: "incremental" },
        { timestamp: "2026-11-04T05:00:00Z", section: "Incoming PO", status: "error", records: 0, message: "older error" },
        { timestamp: "2026-11-04T06:30:00Z", section: "Inventory", status: "completed", records: 900 },
    ];
    const out = summarizeSyncLogs(rows);
    const po = out.find((s) => s.section === "Incoming PO");
    assert.equal(po.lastStatus, "error");
    assert.equal(po.lastError, "Unauthorized");
    assert.equal(po.lastErrorAt, "2026-11-04T07:00:00.000Z");
    assert.equal(po.lastSuccessAt, "2026-11-04T06:00:00.000Z");
    const inv = out.find((s) => s.section === "Inventory");
    assert.equal(inv.lastStatus, "completed");
    assert.equal(inv.lastRecords, 900);
    assert.equal(inv.lastError, null);
});
