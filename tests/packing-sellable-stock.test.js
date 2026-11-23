import test from "node:test";
import assert from "node:assert/strict";
import {
    getStockWarehouseIdsForBranch,
    getPoDestinationIdsForBranch,
    isExcludedBranchAlias,
    isExcludedLocationAlias,
} from "../lib/companies.js";
import { isPackingSellableLine } from "../lib/packing-list.js";

test("junk / tech sites are not packing-list sellable; related metro dests are", () => {
    assert.equal(isPackingSellableLine({ warehouseId: "BACOLOD", branchId: "BACOLOD" }), true);
    assert.equal(isPackingSellableLine({ warehouseId: "MAIN", branchId: "" }), true);
    // Manila / MAIN POs often land on related warehouses — keep them on the packing list
    assert.equal(isPackingSellableLine({ warehouseId: "MNL-MRILAO", branchId: "MANILA" }), true);
    assert.equal(isPackingSellableLine({ warehouseId: "MARILAO", branchId: "" }), true);
    assert.equal(isPackingSellableLine({ warehouseId: "MNL CAL WH", branchId: "" }), true);
    assert.equal(isPackingSellableLine({ warehouseId: "MAIN WH11", branchId: "" }), true);

    // Location / warehouse junk
    assert.equal(isPackingSellableLine({ warehouseId: "SPAREPARTS", branchId: "" }), false);
    assert.equal(isPackingSellableLine({ warehouseId: "DAMAGE", branchId: "MAIN" }), false);
    assert.equal(isPackingSellableLine({ warehouseId: "DISCOUNTED", branchId: "BACOLOD" }), false);
    assert.equal(isPackingSellableLine({ warehouseId: "EXPIRED", branchId: "" }), false);
    assert.equal(isPackingSellableLine({ warehouseId: "DEMO", branchId: "" }), false);
    assert.equal(isPackingSellableLine({ warehouseId: "SKYTECH", branchId: "" }), false);
    assert.equal(isPackingSellableLine({ warehouseId: "SKYTECHMNL", branchId: "" }), false);
    assert.equal(isPackingSellableLine({ warehouseId: "MNL-TECH", branchId: "" }), false);
    assert.equal(isPackingSellableLine({ warehouseId: "SKY ECOM", branchId: "" }), false);
    assert.equal(isPackingSellableLine({ warehouseId: "TESTING", branchId: "" }), false);
    assert.equal(isPackingSellableLine({ warehouseId: "FOO-TECH-BAR", branchId: "" }), false);

    assert.equal(isExcludedBranchAlias("MAIN"), false);
    assert.equal(isExcludedBranchAlias("MARILAO"), true);
    assert.equal(isExcludedBranchAlias("MNL-MRILAO"), true);
    assert.equal(isPackingSellableLine({ warehouseId: "", branchId: "" }), true);
});

test("MAIN bin MARILAO 15 is sellable; bare MARILAO location is not", () => {
    assert.equal(isExcludedLocationAlias("MARILAO 15"), false);
    assert.equal(isExcludedLocationAlias("MARILAO"), true);
    assert.equal(isExcludedLocationAlias("MNL-MRILAO"), true);
    assert.equal(isExcludedLocationAlias("DAMAGE"), true);
    assert.equal(isExcludedLocationAlias("DISCOUNTED"), true);
    assert.equal(isExcludedBranchAlias("MARILAO 15"), false);
    assert.equal(
        isPackingSellableLine({ warehouseId: "MAIN", locationId: "MARILAO 15" }),
        true
    );
    assert.equal(
        isPackingSellableLine({ warehouseId: "MAIN", locationId: "MARILAO" }),
        false
    );
    assert.equal(
        isPackingSellableLine({ warehouseId: "MAIN", locationId: "DAMAGE" }),
        false
    );
});

test("MAIN sellable qty drops bare MARILAO location but keeps MARILAO 15", () => {
    // Sofie vinyl staff case: MAIN locations 15-E… = 0, MARILAO = 42, MARILAO 15 = shelf.
    const rows = [
        { loc: "15-E19 3-2", avail: 0 },
        { loc: "15-E22 2-2", avail: 0 },
        { loc: "MARILAO", avail: 42 },
        { loc: "MARILAO 15", avail: 10 },
    ];
    let sellable = 0;
    for (const r of rows) {
        if (isExcludedLocationAlias(r.loc)) continue;
        sellable += r.avail;
    }
    assert.equal(sellable, 10);
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

test("PO destinations keep related Manila / MAIN warehouses for packing match", () => {
    const manila = getPoDestinationIdsForBranch("MANILA");
    assert.ok(manila.includes("MANILA"));
    assert.ok(manila.includes("MNL-MRILAO"));
    assert.ok(manila.includes("MNL CAL WH"));
    assert.ok(manila.includes("WH1"));

    const main = getPoDestinationIdsForBranch("MAIN");
    assert.ok(main.includes("MAIN"));
    assert.ok(main.includes("MAIN WH11"));

    // Selecting the satellite site still resolves the Manila group
    const fromMarilao = getPoDestinationIdsForBranch("MNL-MRILAO");
    assert.ok(fromMarilao.includes("MANILA"));
    assert.ok(fromMarilao.includes("MNL-MRILAO"));
});
