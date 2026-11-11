import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSavedPackingList, canEditSavedPackingList, describePackingListChange, MAX_SAVED_ORDERS } from "../lib/packing-list-saved.js";
import { containerFillSummary } from "../lib/packing-list.js";

test("snapshot is kept when valid and dropped when nonsense", () => {
    const base = { name: "x", branch: "CDO", orderNbrs: ["A1"] };
    assert.deepEqual(normalizeSavedPackingList({ ...base, snapshot: { cbm: 55.123456, weightKg: 1200.555 } }).value.snapshot, { cbm: 55.1235, weightKg: 1200.56 });
    assert.equal(normalizeSavedPackingList({ ...base, snapshot: { cbm: -1, weightKg: 5 } }).value.snapshot, null);
    assert.equal(normalizeSavedPackingList({ ...base, snapshot: { cbm: "abc", weightKg: 5 } }).value.snapshot, null);
    assert.equal(normalizeSavedPackingList(base).value.snapshot, null);
});

test("describePackingListChange summarises what changed", () => {
    const before = { name: "A", orderNbrs: ["P1", "P2"], manualQty: { "CDO|P1|1": 5 }, truckingFee: 44000 };
    assert.equal(describePackingListChange(null, before), "Saved with 2 PO(s)");
    assert.equal(describePackingListChange(before, { ...before }), "Saved again with no changes");
    const after = { name: "B", orderNbrs: ["P2", "P3"], manualQty: {}, truckingFee: 50000 };
    assert.equal(
        describePackingListChange(before, after),
        'Renamed to "B"; added P3; removed P1; trucking fee 44,000 → 50,000; manual quantities updated'
    );
});

test("containerFillSummary reports the mix and how full it is", () => {
    const one = containerFillSummary(34, 5200);
    assert.equal(one.text, "1 × 40ft Standard");
    assert.equal(one.volumePct, 58.6);
    assert.equal(one.fillPct, 58.6);
    const two = containerFillSummary(100, 1000);
    assert.equal(two.text, "1 × 40ft High Cube + 1 × 40ft Standard");
    assert.equal(two.volumePct, 79.4);
    assert.equal(containerFillSummary(0, 0), null);
});

test("normalizeSavedPackingList keeps a clean record", () => {
    const { value, error } = normalizeSavedPackingList({
        name: "  CDO   November  ",
        branch: "cdo",
        orderNbrs: ["CDOP260171", "CDOP260171", "CDOP260173", "bad;drop table"],
        manualQty: {
            "CDO|CDOP260171|1": "700",
            "CDO|CDOP260173|2": "abc",
            "MAIN|CDOP260171|1": "5",
            "CDO|OTHER|1": "9",
        },
        truckingFee: "44,000",
    });
    assert.equal(error, undefined);
    assert.equal(value.name, "CDO November");
    assert.equal(value.branch, "CDO");
    assert.deepEqual(value.orderNbrs, ["CDOP260171", "CDOP260173"]);
    assert.deepEqual(value.manualQty, { "CDO|CDOP260171|1": 700 });
    assert.equal(value.truckingFee, 44000);
});

test("normalizeSavedPackingList rejects missing name, branch, POs and bad fee", () => {
    assert.match(normalizeSavedPackingList({ branch: "CDO", orderNbrs: ["A1"] }).error, /name/);
    assert.match(normalizeSavedPackingList({ name: "x", orderNbrs: ["A1"] }).error, /branch/);
    assert.match(normalizeSavedPackingList({ name: "x", branch: "CDO", orderNbrs: [] }).error, /purchase order/);
    assert.match(normalizeSavedPackingList({ name: "x", branch: "CDO", orderNbrs: ["A1"], truckingFee: "lots" }).error, /trucking fee/);
    const many = Array.from({ length: MAX_SAVED_ORDERS + 1 }, (_, i) => `PO${i}`);
    assert.match(normalizeSavedPackingList({ name: "x", branch: "CDO", orderNbrs: many }).error, /up to/);
    assert.equal(normalizeSavedPackingList({ name: "x", branch: "CDO", orderNbrs: ["A1"], truckingFee: "" }).value.truckingFee, null);
});

test("canEditSavedPackingList allows the creator and admins only", () => {
    const rec = { createdBy: "Carlo" };
    assert.equal(canEditSavedPackingList(rec, { username: "carlo", role: "user" }), true);
    assert.equal(canEditSavedPackingList(rec, { username: "maria", role: "user" }), false);
    assert.equal(canEditSavedPackingList(rec, { username: "maria", role: "admin" }), true);
    assert.equal(canEditSavedPackingList(rec, null), false);
    assert.equal(canEditSavedPackingList({ createdBy: null }, { username: "x", role: "user" }), false);
});
