import test from "node:test";
import assert from "node:assert/strict";
import { mapHeaders } from "../lib/item-dimensions.js";
import { MISSING_DIMENSION_COLUMNS, missingBySupplier, missingDimensionsSheetRows, missingLabel } from "../lib/missing-dimensions.js";

test("sheet headers are accepted by the dimensions import", () => {
    const map = mapHeaders(MISSING_DIMENSION_COLUMNS);
    assert.equal(map.inventory_id, 0);
    for (const key of ["pcs_per_box", "length_m", "height_m", "width_m", "weight_kg", "cbm"]) {
        assert.notEqual(map[key], undefined, `${key} column is recognised`);
    }
});

test("rows leave size columns blank and add PO details", () => {
    const rows = missingDimensionsSheetRows([
        { inventoryId: "ITEM-A", description: "Lamp", openQty: 40, poCount: 3, missingSize: true, missingWeight: false, suppliers: ["Alpha", "Beta"] },
    ]);
    assert.equal(rows.length, 2);
    const row = rows[1];
    assert.equal(row.length, MISSING_DIMENSION_COLUMNS.length);
    assert.equal(row[0], "ITEM-A");
    assert.deepEqual(row.slice(1, 7), [null, null, null, null, null, null]);
    assert.deepEqual(row.slice(7), ["Lamp", 40, 3, "Size", "Alpha, Beta"]);
});

test("missingBySupplier groups items per supplier, most items first", () => {
    const groups = missingBySupplier([
        { inventoryId: "A", openQty: 10, missingSize: true, missingWeight: true, suppliers: ["Alpha"] },
        { inventoryId: "B", openQty: 5, missingSize: true, missingWeight: false, suppliers: ["Alpha", "Beta"] },
        { inventoryId: "C", openQty: 1, missingSize: false, missingWeight: true, suppliers: [] },
    ]);
    assert.deepEqual(groups, [
        { supplier: "Alpha", itemCount: 2, openQty: 15, missingBoth: 1 },
        { supplier: "(no supplier on PO)", itemCount: 1, openQty: 1, missingBoth: 0 },
        { supplier: "Beta", itemCount: 1, openQty: 5, missingBoth: 0 },
    ]);
});

test("missing label names what is missing", () => {
    assert.equal(missingLabel({ missingSize: true, missingWeight: true }), "Size and weight");
    assert.equal(missingLabel({ missingSize: false, missingWeight: true }), "Weight");
    assert.equal(missingLabel({}), "");
});
