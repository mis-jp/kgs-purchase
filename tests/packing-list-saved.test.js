import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSavedPackingList, canEditSavedPackingList, MAX_SAVED_ORDERS } from "../lib/packing-list-saved.js";

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
