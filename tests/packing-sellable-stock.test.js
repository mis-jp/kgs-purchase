import test from "node:test";
import assert from "node:assert/strict";
import { getStockWarehouseIdsForBranch, isExcludedBranchAlias } from "../lib/companies.js";
import { isPackingSellableLine } from "../lib/packing-list.js";

test("Acumatica Inventory Summary exclusions are not packing-list sellable", () => {
    assert.equal(isPackingSellableLine({ warehouseId: "BACOLOD", branchId: "BACOLOD" }), true);
    assert.equal(isPackingSellableLine({ warehouseId: "MAIN", branchId: "" }), true);
    assert.equal(isPackingSellableLine({ warehouseId: "MNL-MRILAO", branchId: "MANILA" }), true);

    // Location Does Not Contain
    assert.equal(isPackingSellableLine({ warehouseId: "SPAREPARTS", branchId: "" }), false);
    assert.equal(isPackingSellableLine({ warehouseId: "DAMAGE", branchId: "MAIN" }), false);
    assert.equal(isPackingSellableLine({ warehouseId: "DISCOUNTED", branchId: "BACOLOD" }), false);
    assert.equal(isPackingSellableLine({ warehouseId: "EXPIRED", branchId: "" }), false);
    assert.equal(isPackingSellableLine({ warehouseId: "DEMO", branchId: "" }), false);

    // Warehouse / Location Does Not Equal
    assert.equal(isPackingSellableLine({ warehouseId: "MAIN WH11", branchId: "" }), false);
    assert.equal(isPackingSellableLine({ warehouseId: "SKYTECH", branchId: "" }), false);
    assert.equal(isPackingSellableLine({ warehouseId: "SKYTECHMNL", branchId: "" }), false);
    assert.equal(isPackingSellableLine({ warehouseId: "MNL CAL WH", branchId: "" }), false);
    assert.equal(isPackingSellableLine({ warehouseId: "MNL-TECH", branchId: "" }), false);
    assert.equal(isPackingSellableLine({ warehouseId: "SKY ECOM", branchId: "" }), false);
    assert.equal(isPackingSellableLine({ warehouseId: "TESTING", branchId: "" }), false);

    // Warehouse Does Not Contain TECH
    assert.equal(isPackingSellableLine({ warehouseId: "FOO-TECH-BAR", branchId: "" }), false);

    // Unchecked filters must remain allowed
    assert.equal(isExcludedBranchAlias("MAIN"), false);
    assert.equal(isExcludedBranchAlias("MARILAO"), false);
    assert.equal(isPackingSellableLine({ warehouseId: "", branchId: "" }), true);
});

test("branch stock groups drop excluded warehouses from Acumatica filter", () => {
    assert.deepEqual(getStockWarehouseIdsForBranch("DAMAGE"), []);
    assert.deepEqual(getStockWarehouseIdsForBranch("MAIN WH11"), []);
    assert.deepEqual(getStockWarehouseIdsForBranch("MNL-TECH"), []);
    assert.ok(!getStockWarehouseIdsForBranch("MAIN").includes("MAIN WH11"));
    assert.ok(getStockWarehouseIdsForBranch("MAIN").includes("MAIN"));
    assert.ok(!getStockWarehouseIdsForBranch("MANILA").includes("MNL CAL WH"));
    assert.ok(getStockWarehouseIdsForBranch("MANILA").includes("MANILA"));
    assert.ok(getStockWarehouseIdsForBranch("MANILA").includes("MNL-MRILAO"));
    assert.ok(getStockWarehouseIdsForBranch("BACOLOD").includes("BACOLOD"));
});
