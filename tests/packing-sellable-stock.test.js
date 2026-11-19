import test from "node:test";
import assert from "node:assert/strict";
import { getStockWarehouseIdsForBranch } from "../lib/companies.js";
import { isPackingSellableLine } from "../lib/packing-list.js";

test("DAMAGE and DISCOUNTED PO lines are not packing-list sellable", () => {
    assert.equal(isPackingSellableLine({ warehouseId: "BACOLOD", branchId: "BACOLOD" }), true);
    assert.equal(isPackingSellableLine({ warehouseId: "MAIN", branchId: "" }), true);
    assert.equal(isPackingSellableLine({ warehouseId: "DAMAGE", branchId: "MAIN" }), false);
    assert.equal(isPackingSellableLine({ warehouseId: "MAIN", branchId: "DAMAGE" }), false);
    assert.equal(isPackingSellableLine({ warehouseId: "DISCOUNTED", branchId: "BACOLOD" }), false);
    assert.equal(isPackingSellableLine({ warehouseId: "DISCOUNTED LOCATION", branchId: "" }), false);
    assert.equal(isPackingSellableLine({ warehouse_id: "MAIN DAMAGE WH", branch_id: "MAIN" }), false);
    assert.equal(isPackingSellableLine({ warehouseId: "", branchId: "" }), true);
});

test("branch stock warehouse groups never include DAMAGE or DISCOUNTED", () => {
    assert.deepEqual(getStockWarehouseIdsForBranch("DAMAGE"), []);
    assert.deepEqual(getStockWarehouseIdsForBranch("DISCOUNTED"), []);
    assert.ok(!getStockWarehouseIdsForBranch("MAIN").some((id) => /DAMAGE|DISCOUNTED/i.test(id)));
    assert.ok(getStockWarehouseIdsForBranch("BACOLOD").includes("BACOLOD"));
    assert.ok(getStockWarehouseIdsForBranch("MAIN").includes("MAIN"));
});
