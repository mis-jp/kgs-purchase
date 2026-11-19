import test from "node:test";
import assert from "node:assert/strict";
import { acumaticaList, findVendorRenames } from "../lib/vendor-sync.js";

test("acumaticaList reads plain arrays and OData value lists", () => {
    assert.deepEqual(acumaticaList([{ a: 1 }]), [{ a: 1 }]);
    assert.deepEqual(acumaticaList({ value: [{ a: 2 }] }), [{ a: 2 }]);
    assert.deepEqual(acumaticaList({}), []);
    assert.deepEqual(acumaticaList(null), []);
});

test("a vendor renamed in Acumatica is reported with old and new names", () => {
    const saved = [
        { vendor_id: "VM000010", vendor_name: "Liyu" },
        { vendor_id: "VM000060", vendor_name: "IECHO Cutter" },
    ];
    const incoming = [
        { vendor_id: "VM000010", vendor_name: "Liyu Cutter" },
        { vendor_id: "VM000060", vendor_name: "IECHO Cutter" },
    ];
    assert.deepEqual(findVendorRenames(saved, incoming), [{ vendorId: "VM000010", from: "Liyu", to: "Liyu Cutter" }]);
});

test("case-only changes count; new vendors, blank names and padding do not", () => {
    const saved = [
        { vendor_id: "VE000036", vendor_name: "KELIN CDO" },
        { vendor_id: "VM000046", vendor_name: "ML" },
        { vendor_id: "VM000184", vendor_name: "EX" },
    ];
    const incoming = [
        { vendor_id: "ve000036", vendor_name: "Kelin CDO" },
        { vendor_id: "VM000046", vendor_name: "" },
        { vendor_id: "VM000184", vendor_name: " EX " },
        { vendor_id: "VM999999", vendor_name: "Brand New Supplier" },
    ];
    assert.deepEqual(findVendorRenames(saved, incoming), [{ vendorId: "ve000036", from: "KELIN CDO", to: "Kelin CDO" }]);
});
