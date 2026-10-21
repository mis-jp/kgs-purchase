import { test } from "node:test";
import assert from "node:assert/strict";
import {
    adminLoginIds, assertNotOwnRequest, assertTransferAction, canApprove, canOperate, countLineDifference,
    countLineState, csvCell, formatDocNumber, manilaDay, normalizeLines, permissionFlags, requireRequestId,
    stockStatusFor, toCsv,
} from "../app/api/flutter-kelinconnect-inventory/_lib/rules.js";

const member = (role, { all = false, branches = [] } = {}) => ({
    loginId: "KG0001", role, allBranches: all, branchIds: new Set(branches),
});

test("operate: admin anywhere, staff/manager only assigned branches, viewer never", () => {
    assert.equal(canOperate(member("admin"), 9), true);
    assert.equal(canOperate(member("staff", { branches: [3] }), 3), true);
    assert.equal(canOperate(member("staff", { branches: [3] }), 4), false);
    assert.equal(canOperate(member("manager", { all: true }), 4), true);
    assert.equal(canOperate(member("viewer", { all: true }), 4), false);
});

test("approve: only admins and managers of the branch", () => {
    assert.equal(canApprove(member("admin"), 1), true);
    assert.equal(canApprove(member("manager", { branches: [1] }), 1), true);
    assert.equal(canApprove(member("manager", { branches: [1] }), 2), false);
    assert.equal(canApprove(member("staff", { all: true }), 1), false);
});

test("nobody approves their own request", () => {
    assert.throws(() => assertNotOwnRequest(member("admin"), "kg0001"), { status: 403 });
    assert.doesNotThrow(() => assertNotOwnRequest(member("admin"), "KG0002"));
});

test("permission flags per role", () => {
    assert.deepEqual(permissionFlags(member("viewer")), {
        canOperate: false, canApprove: false, canAdmin: false, canExport: false, canViewAudit: false,
    });
    assert.equal(permissionFlags(member("manager")).canApprove, true);
    assert.equal(permissionFlags(member("admin")).canAdmin, true);
});

test("count line state uses the recount when present", () => {
    assert.equal(countLineState({ systemQty: 5, countedQty: null }), "pending");
    assert.equal(countLineState({ systemQty: 5, countedQty: 5 }), "matched");
    assert.equal(countLineState({ systemQty: 5, countedQty: 3 }), "short");
    assert.equal(countLineState({ systemQty: 5, countedQty: 3, recountQty: 5 }), "matched");
    assert.equal(countLineState({ systemQty: 5, countedQty: 7 }), "over");
    assert.equal(countLineState({ systemQty: 5, countedQty: 0, missing: true }), "missing");
    assert.equal(countLineDifference({ systemQty: 5, countedQty: 0, missing: true }), -5);
    assert.equal(countLineDifference({ systemQty: 5, countedQty: 8, recountQty: 6 }), 1);
    assert.equal(countLineDifference({ systemQty: 5, countedQty: null }), null);
});

test("transfer steps follow the approved order", () => {
    assert.doesNotThrow(() => assertTransferAction("pending_approval", "approve"));
    assert.doesNotThrow(() => assertTransferAction("approved", "dispatch"));
    assert.doesNotThrow(() => assertTransferAction("in_transit", "receive"));
    assert.throws(() => assertTransferAction("pending_approval", "dispatch"), { status: 409 });
    assert.throws(() => assertTransferAction("in_transit", "cancel"), { status: 409 });
    assert.throws(() => assertTransferAction("received", "receive"), { status: 409 });
});

test("movement lines: positive quantities, no duplicates", () => {
    assert.deepEqual(normalizeLines([{ inventoryId: "abc", qty: "2.5" }]), [{ ref: "abc", qty: 2.5, note: null }]);
    assert.throws(() => normalizeLines([]), { status: 400 });
    assert.throws(() => normalizeLines([{ inventoryId: "A", qty: 0 }]), { status: 400 });
    assert.throws(() => normalizeLines([{ inventoryId: "A", qty: -1 }]), { status: 400 });
    assert.throws(() => normalizeLines([{ inventoryId: "A", qty: 1 }, { inventoryId: "a", qty: 2 }]), { status: 400 });
});

test("request ids must be UUIDs", () => {
    assert.equal(requireRequestId("3F2504E0-4F89-41D3-9A0C-0305E82C3301"), "3f2504e0-4f89-41d3-9a0c-0305e82c3301");
    assert.throws(() => requireRequestId("abc"), { status: 400 });
});

test("document numbers use the Manila date", () => {
    assert.equal(manilaDay(new Date("2026-10-21T17:30:00Z")), "20261022");
    assert.equal(manilaDay(new Date("2026-10-21T15:59:00Z")), "20261021");
    assert.equal(formatDocNumber("REL", "20261021", 7), "REL-20261021-0007");
});

test("stock status uses the minimum", () => {
    assert.equal(stockStatusFor(0, 5), "out_of_stock");
    assert.equal(stockStatusFor(4, 5), "low_stock");
    assert.equal(stockStatusFor(5, 5), "healthy");
});

test("bootstrap admins parse from a comma list", () => {
    assert.deepEqual([...adminLoginIds(" kg0751, KG0543 ,,")], ["KG0751", "KG0543"]);
});

test("CSV cells are quoted and formula-safe", () => {
    assert.equal(csvCell('a,"b"'), '"a,""b"""');
    assert.equal(csvCell("=SUM(A1)"), "'=SUM(A1)");
    assert.equal(csvCell("-5"), "-5");
    assert.equal(csvCell(null), "");
    assert.ok(toCsv(["A"], [[1]]).startsWith("\uFEFFA\r\n1"));
});
