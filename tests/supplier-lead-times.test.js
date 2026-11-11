import test from "node:test";
import assert from "node:assert/strict";
import { summarizeSupplierLeadTimes } from "../lib/supplier-lead-times.js";
import { daysPastPromised } from "../lib/po-overdue.js";

const today = new Date("2026-11-11T08:00:00Z");

test("summarizeSupplierLeadTimes computes typical, range, on-time and trend", () => {
    const delivered = [
        { vendorId: "V1", vendorName: "Alpha", leadDays: 20, lateDays: -2, receivedOn: "2026-03-01" },
        { vendorId: "V1", vendorName: "Alpha", leadDays: 22, lateDays: 0, receivedOn: "2026-04-01" },
        { vendorId: "V1", vendorName: "Alpha", leadDays: 24, lateDays: 4, receivedOn: "2026-05-01" },
        { vendorId: "V1", vendorName: "Alpha", leadDays: 40, lateDays: 18, receivedOn: "2026-10-20" },
        { vendorId: "V1", vendorName: "Alpha", leadDays: 44, lateDays: 20, receivedOn: "2026-11-01" },
        { vendorId: "V2", vendorName: "", leadDays: 5, lateDays: null, receivedOn: "2026-10-01" },
    ];
    const open = [
        { vendorId: "V1", openCount: 3, overdueCount: 1 },
        { vendorId: "V3", vendorName: "Gamma", openCount: 2, overdueCount: 2 },
    ];
    const rows = summarizeSupplierLeadTimes(delivered, open, today);
    assert.deepEqual(rows.map((r) => r.vendorId), ["V1", "V2", "V3"]);

    const v1 = rows[0];
    assert.equal(v1.delivered, 5);
    assert.equal(v1.typicalDays, 24);
    assert.equal(v1.avgDays, 30);
    assert.equal(v1.fastestDays, 20);
    assert.equal(v1.slowestDays, 44);
    assert.equal(v1.recentAvgDays, 42);
    assert.equal(v1.trend, "slower");
    assert.equal(v1.onTimePct, 40);
    assert.equal(v1.avgDaysLate, 14);
    assert.equal(v1.openCount, 3);
    assert.equal(v1.overdueCount, 1);

    assert.equal(rows[1].vendorName, "V2");
    assert.equal(rows[1].onTimePct, null);
    assert.equal(rows[2].delivered, 0);
    assert.equal(rows[2].typicalDays, null);
    assert.equal(rows[2].vendorName, "Gamma");
});

test("daysPastPromised counts only open orders past the promised date", () => {
    const now = new Date(2026, 10, 11);
    assert.equal(daysPastPromised({ status: "Open", promisedDate: "2026-11-01" }, now), 10);
    assert.equal(daysPastPromised({ status: "On Hold", promisedDate: "2026-11-10" }, now), 1);
    assert.equal(daysPastPromised({ status: "Open", promisedDate: "2026-11-11" }, now), 0);
    assert.equal(daysPastPromised({ status: "Closed", promisedDate: "2026-01-01" }, now), 0);
    assert.equal(daysPastPromised({ status: "Open", promisedDate: null }, now), 0);
    assert.equal(daysPastPromised({ status: "Open", promisedDate: new Date(2026, 9, 31).toISOString() }, now), 11);
});
