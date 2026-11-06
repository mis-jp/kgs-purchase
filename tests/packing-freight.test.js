import test from "node:test";
import assert from "node:assert/strict";
import { freightRatePerCbm, packingLineFreight, packingSheetRows } from "../lib/packing-list.js";

test("freightRatePerCbm divides the trucking fee by total CBM", () => {
    assert.equal(Math.round(freightRatePerCbm("44,000", 68) * 100) / 100, 647.06);
    assert.equal(freightRatePerCbm("", 68), null);
    assert.equal(freightRatePerCbm("abc", 68), null);
    assert.equal(freightRatePerCbm(44000, 0), null);
});

test("packingLineFreight shares the fee by CBM and per piece (manager's sample)", () => {
    const rate = freightRatePerCbm(44000, 68);
    const a = packingLineFreight({ cbm: 40.8, qty: 600 }, rate);
    const b = packingLineFreight({ cbm: 27.2, qty: 400 }, rate);
    assert.equal(Math.round(a.freight * 100) / 100, 26400);
    assert.equal(Math.round(a.freightPerPc * 100) / 100, 44);
    assert.equal(Math.round(b.freight * 100) / 100, 17600);
    assert.equal(Math.round(b.freightPerPc * 100) / 100, 44);
    assert.deepEqual(packingLineFreight({ cbm: null, qty: 5 }, rate), { freight: null, freightPerPc: null });
    assert.equal(packingLineFreight({ cbm: 1, qty: 0 }, rate).freightPerPc, null);
});

test("packingSheetRows adds freight columns and a freight total equal to the fee", () => {
    // 1 m x 1 m x 1 m box of 10 pcs = 0.1 m³ per piece
    const dims = { length_m: 1, height_m: 1, width_m: 1, pcs_per_box: 10, weight_kg: 25 };
    const lines = [
        { orderNbr: "MPO260702", orderDate: "2026-10-30", lineNbr: 1, inventoryId: "A", qty: 408, dimensions: dims },
        { orderNbr: "MPO260702", orderDate: "2026-10-30", lineNbr: 2, inventoryId: "B", qty: 272, dimensions: dims },
    ];
    const rows = packingSheetRows(lines, {}, "MAIN", "44000");
    assert.equal(rows[0][9], 26400);
    assert.equal(rows[0][10], 64.71);
    assert.equal(rows[1][9], 17600);
    assert.equal(rows[2][9], 44000);
});
