import test from "node:test";
import assert from "node:assert/strict";
import { daysPastPromised } from "../lib/po-overdue.js";

function parseLateMinDays(value) {
    const n = parseInt(String(value ?? "").trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

function matchesLateMin(po, lateMinDays, today = new Date("2026-11-23T00:00:00")) {
    const lateMin = parseLateMinDays(lateMinDays);
    if (lateMin <= 0) return true;
    return daysPastPromised(po, today) >= lateMin;
}

test("Late ≥ filter keeps only open POs past the minimum days", () => {
    const today = new Date(2026, 10, 23); // Nov 23, 2026 local
    const open10 = { status: "Open", promisedDate: "2026-11-13" };
    const open60 = { status: "Open", promisedDate: "2026-09-24" };
    const closed = { status: "Closed", promisedDate: "2026-01-01" };

    assert.equal(daysPastPromised(open10, today), 10);
    assert.equal(matchesLateMin(open10, "1", today), true);
    assert.equal(matchesLateMin(open10, "10", today), true);
    assert.equal(matchesLateMin(open10, "11", today), false);
    assert.equal(matchesLateMin(open60, "30", today), true);
    assert.equal(matchesLateMin(closed, "1", today), false);
    assert.equal(matchesLateMin(open10, "", today), true);
});
