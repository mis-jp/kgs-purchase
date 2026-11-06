import test from "node:test";
import assert from "node:assert/strict";
import {
    PACKING_COLUMNS,
    packingLineKey,
    packingLineTotals,
    packingQty,
    packingSheetRows,
    packingTotals,
    parseManualQty,
    sortPackingLines,
} from "../lib/packing-list.js";

const box = { length_m: 0.5, height_m: 0.4, width_m: 0.5, pcs_per_box: 10, weight_kg: 20 }; // 0.1 m³ / 20 kg per box

const lineA = { orderNbr: "TARP260091", orderDate: "2026-10-01", lineNbr: 1, inventoryId: "ITEM-A", qty: 20, dimensions: box };
const lineB = { orderNbr: "TARP260091", orderDate: "2026-10-01", lineNbr: 2, inventoryId: "ITEM-B", qty: 5, dimensions: null };
const lineC = { orderNbr: "TARP260095", orderDate: "2026-10-05", lineNbr: 1, inventoryId: "ITEM-C", qty: 3, dimensions: { cbm: 0.2, weight_kg: 4 } };

test("parseManualQty ignores blank, invalid and negative values", () => {
    assert.equal(parseManualQty(""), null);
    assert.equal(parseManualQty("  "), null);
    assert.equal(parseManualQty("abc"), null);
    assert.equal(parseManualQty("-1"), null);
    assert.equal(parseManualQty("1,250"), 1250);
    assert.equal(parseManualQty("0"), 0);
});

test("manual qty wins, otherwise order qty is used", () => {
    assert.equal(packingQty(20, ""), 20);
    assert.equal(packingQty(20, "8"), 8);
    assert.equal(packingQty(-3, ""), 0);
});

test("line CBM and weight follow PCS/BOX", () => {
    const t = packingLineTotals(lineA, "");
    assert.equal(t.qty, 20);
    assert.ok(Math.abs(t.cbm - 0.2) < 1e-9);
    assert.ok(Math.abs(t.weightKg - 40) < 1e-9);
    assert.equal(t.overOrdered, false);
});

test("items without PCS/BOX use CBM per piece", () => {
    const t = packingLineTotals(lineC, "");
    assert.ok(Math.abs(t.cbm - 0.6) < 1e-9);
    assert.ok(Math.abs(t.weightKg - 12) < 1e-9);
});

test("manual qty above order qty is flagged; zero gives zero CBM", () => {
    assert.equal(packingLineTotals(lineA, "25").overOrdered, true);
    const zero = packingLineTotals(lineA, "0");
    assert.equal(zero.cbm, 0);
    assert.equal(zero.weightKg, 0);
});

test("items without size are counted, not summed", () => {
    const totals = packingTotals([lineA, lineB, lineC], {}, "TAR");
    assert.equal(totals.orderCount, 2);
    assert.equal(totals.lineCount, 3);
    assert.equal(totals.qty, 28);
    assert.equal(totals.cbm, 0.8);
    assert.equal(totals.weightKg, 52);
    assert.equal(totals.missingCbm, 1);
    assert.equal(totals.missingWeight, 1);
});

test("totals use manual qty by line key", () => {
    const manual = { [packingLineKey("TAR", "TARP260091", 1, "ITEM-A")]: "10" };
    const totals = packingTotals([lineA], manual, "tar");
    assert.equal(totals.qty, 10);
    assert.equal(totals.cbm, 0.1);
    assert.equal(totals.weightKg, 20);
});

test("lines sort newest order first, then line number", () => {
    const sorted = sortPackingLines([lineB, lineA, lineC]);
    assert.deepEqual(sorted.map((l) => `${l.orderNbr}/${l.lineNbr}`), ["TARP260095/1", "TARP260091/1", "TARP260091/2"]);
});

test("sheet rows follow the column order and end with totals", () => {
    assert.equal(PACKING_COLUMNS.length, 11);
    const rows = packingSheetRows([lineA, lineB], {}, "TAR");
    assert.equal(rows.length, 3);
    const [branch, orderNbr, date, desc, inv, orderQty, manualQty, cbm, kg] = rows[0];
    assert.equal(branch, "TAR");
    assert.equal(orderNbr, "TARP260091");
    assert.ok(date instanceof Date);
    assert.equal(desc, "");
    assert.equal(inv, "ITEM-A");
    assert.equal(orderQty, 20);
    assert.equal(manualQty, 20);
    assert.equal(cbm, 0.2);
    assert.equal(kg, 40);
    assert.equal(rows[1][7], null);
    assert.deepEqual(rows[2], ["Total", "1 PO(s)", null, "2 line(s)", null, null, 25, 0.2, 40, null, null]);
});
