import test from "node:test";
import assert from "node:assert/strict";
import {
    getStockWarehouseIdsForBranch,
    isExcludedBranchAlias,
    isExcludedLocationAlias,
} from "../lib/companies.js";
import { isPackingSellableLine } from "../lib/packing-list.js";

test("Acumatica Inventory Summary exclusions are not packing-list sellable", () => {
    assert.equal(isPackingSellableLine({ warehouseId: "BACOLOD", branchId: "BACOLOD" }), true);
    assert.equal(isPackingSellableLine({ warehouseId: "MAIN", branchId: "" }), true);
    assert.equal(isPackingSellableLine({ warehouseId: "MNL-MRILAO", branchId: "MANILA" }), false);
    assert.equal(isPackingSellableLine({ warehouseId: "MARILAO", branchId: "" }), false);

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

    // MAIN stays allowed
    assert.equal(isExcludedBranchAlias("MAIN"), false);
    assert.equal(isExcludedBranchAlias("MARILAO"), true);
    assert.equal(isExcludedBranchAlias("MNL-MRILAO"), true);
    assert.equal(isPackingSellableLine({ warehouseId: "", branchId: "" }), true);
});

test("MAIN bin MARILAO 15 is sellable; DAMAGE location is not", () => {
    assert.equal(isExcludedLocationAlias("MARILAO 15"), false);
    assert.equal(isExcludedLocationAlias("DAMAGE"), true);
    assert.equal(isExcludedLocationAlias("DISCOUNTED"), true);
    assert.equal(isExcludedBranchAlias("MARILAO 15"), false);
    assert.equal(
        isPackingSellableLine({ warehouseId: "MAIN", locationId: "MARILAO 15" }),
        true
    );
    assert.equal(
        isPackingSellableLine({ warehouseId: "MAIN", locationId: "DAMAGE" }),
        false
    );
});

test("branch stock groups drop excluded warehouses from Acumatica filter", () => {
    assert.deepEqual(getStockWarehouseIdsForBranch("DAMAGE"), []);
    assert.deepEqual(getStockWarehouseIdsForBranch("MAIN WH11"), []);
    assert.deepEqual(getStockWarehouseIdsForBranch("MNL-TECH"), []);
    assert.deepEqual(getStockWarehouseIdsForBranch("MNL-MRILAO"), []);
    assert.deepEqual(getStockWarehouseIdsForBranch("MARILAO"), []);
    assert.ok(!getStockWarehouseIdsForBranch("MAIN").includes("MAIN WH11"));
    assert.ok(getStockWarehouseIdsForBranch("MAIN").includes("MAIN"));
    assert.ok(!getStockWarehouseIdsForBranch("MANILA").includes("MNL CAL WH"));
    assert.ok(!getStockWarehouseIdsForBranch("MANILA").includes("MNL-MRILAO"));
    assert.ok(getStockWarehouseIdsForBranch("MANILA").includes("MANILA"));
    assert.ok(getStockWarehouseIdsForBranch("BACOLOD").includes("BACOLOD"));
});
