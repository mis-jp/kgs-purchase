import test from "node:test";
import assert from "node:assert/strict";
import {
    dimensionIssue,
    packingLineKey,
    packingLineTotals,
    packingSheetRows,
    packingStockColumns,
    packingStockPlan,
    packingTotals,
} from "../lib/packing-list.js";

// Real rows from Stock Items
const foamBoard = { pcs_per_box: 20, length_m: 2.44, height_m: 1, width_m: 1.22, weight_kg: 8.2, cbm: 2.9768 };
const foamBoardFixed = { ...foamBoard, height_m: 0.1, cbm: 0.29768 };
const typedInCm = { pcs_per_box: 1, length_m: 50.5, height_m: 35, width_m: 35, weight_kg: 24.5 };
const pvcSheet = { pcs_per_box: 200, length_m: 1.23, height_m: 2.45, width_m: 0.36, weight_kg: 888, cbm: 1.08486 };

test("sizes typed in centimetres are flagged and left out of CBM", () => {
    assert.equal(dimensionIssue(typedInCm), "oversize");
    const t = packingLineTotals({ qty: 10, dimensions: typedInCm }, "");
    assert.equal(t.cbm, null);
    assert.equal(t.sizeIssue, "oversize");
    assert.ok(t.weightKg > 0);
});

test("a carton lighter than packing foam is flagged but still counted", () => {
    assert.equal(dimensionIssue(foamBoard), "too-light");
    const t = packingLineTotals({ qty: 2000, dimensions: foamBoard }, "");
    assert.ok(Math.abs(t.cbm - 297.68) < 1e-6);
    assert.equal(t.sizeIssue, "too-light");
});

test("normal cartons have no size issue; the fixed foam board gives 29.768 m³", () => {
    assert.equal(dimensionIssue(pvcSheet), null);
    assert.equal(dimensionIssue(foamBoardFixed), null);
    assert.equal(dimensionIssue(null), null);
    assert.ok(Math.abs(packingLineTotals({ qty: 2000, dimensions: foamBoardFixed }, "").cbm - 29.768) < 1e-6);
});

test("totals count size issues and skip oversize CBM", () => {
    const lines = [
        { orderNbr: "A", lineNbr: 1, inventoryId: "CM", qty: 10, dimensions: typedInCm },
        { orderNbr: "A", lineNbr: 2, inventoryId: "FOAM", qty: 20, dimensions: foamBoard },
        { orderNbr: "A", lineNbr: 3, inventoryId: "PVC", qty: 200, dimensions: pvcSheet },
    ];
    const totals = packingTotals(lines, {}, "MAIN");
    assert.equal(totals.oversize, 1);
    assert.equal(totals.tooLight, 1);
    assert.equal(totals.missingCbm, 1);
    assert.equal(totals.cbm, Math.round((2.9768 + 1.08486) * 10000) / 10000);
});

const cdoLines = [
    { orderNbr: "P2", orderDate: "2026-11-02", lineNbr: 1, inventoryId: "X", qty: 60, branchStock: 5, mainStock: 100 },
    { orderNbr: "P1", orderDate: "2026-11-01", lineNbr: 1, inventoryId: "X", qty: 70, branchStock: 5, mainStock: 100 },
    { orderNbr: "P1", orderDate: "2026-11-01", lineNbr: 2, inventoryId: "Y", qty: 10, branchStock: 0, mainStock: 0 },
];

test("MAIN stock is shared across lines of the same item, newest line first", () => {
    const plan = packingStockPlan(cdoLines, {}, "CDO");
    assert.equal(plan.isMain, false);
    assert.deepEqual(plan.byKey.get(packingLineKey("CDO", "P2", 1, "X")), { branchStock: 5, mainStock: 100, transfer: 60, short: 0 });
    assert.deepEqual(plan.byKey.get(packingLineKey("CDO", "P1", 1, "X")), { branchStock: 5, mainStock: 100, transfer: 40, short: 30 });
    assert.deepEqual(plan.byKey.get(packingLineKey("CDO", "P1", 2, "Y")), { branchStock: 0, mainStock: 0, transfer: 0, short: 10 });
    assert.equal(plan.transfer, 100);
    assert.equal(plan.short, 40);
    assert.equal(plan.shortLines, 2);
});

test("manual qty changes what MAIN needs to send", () => {
    const manual = { [packingLineKey("CDO", "P2", 1, "X")]: "20" };
    const plan = packingStockPlan(cdoLines, manual, "CDO");
    assert.equal(plan.byKey.get(packingLineKey("CDO", "P1", 1, "X")).transfer, 70);
    assert.equal(plan.transfer, 90);
});

test("MAIN branch shows its own stock and no transfer", () => {
    const plan = packingStockPlan([{ orderNbr: "P", lineNbr: 1, inventoryId: "X", qty: 5, branchStock: 12, mainStock: 12 }], {}, "main");
    assert.equal(plan.isMain, true);
    assert.deepEqual(plan.byKey.get(packingLineKey("main", "P", 1, "X")), { branchStock: 12, mainStock: 12, transfer: null, short: null });
    assert.deepEqual(packingStockColumns("MAIN"), ["Main Stock"]);
    assert.deepEqual(packingStockColumns("cdo"), ["Main Stock", "CDO Stock", "Transfer from Main"]);
});

test("Excel rows add stock columns after Freight/Pc only when asked", () => {
    assert.equal(packingSheetRows(cdoLines, {}, "CDO")[0].length, 11);
    const rows = packingSheetRows(cdoLines, {}, "CDO", null, { stock: true });
    assert.deepEqual(rows[0].slice(11), [100, 5, 60]);
    assert.deepEqual(rows[1].slice(11), [100, 5, 40]);
    assert.deepEqual(rows.at(-1).slice(11), [null, null, 100]);
});
