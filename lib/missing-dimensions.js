import { DIMENSION_FIELDS } from "./item-dimensions.js";

/**
 * Sheet for "items on open POs missing sizes". The first columns match the
 * dimensions import (Inventory ID + size columns, left blank to fill in);
 * the extra columns at the end are ignored by the import.
 */
export const MISSING_DIMENSION_COLUMNS = [
    "Inventory ID",
    ...DIMENSION_FIELDS.map((f) => f.label),
    "Description",
    "Open PO Qty",
    "PO Count",
    "Missing",
    "Suppliers",
];

export function missingLabel(item) {
    if (item?.missingSize && item?.missingWeight) return "Size and weight";
    if (item?.missingSize) return "Size";
    if (item?.missingWeight) return "Weight";
    return "";
}

export function missingDimensionsSheetRows(items = []) {
    const blanks = DIMENSION_FIELDS.map(() => null);
    return [
        MISSING_DIMENSION_COLUMNS,
        ...items.map((item) => [
            item.inventoryId,
            ...blanks,
            item.description || "",
            Number(item.openQty) || 0,
            Number(item.poCount) || 0,
            missingLabel(item),
            (item.suppliers || []).join(", "),
        ]),
    ];
}

/** Items missing sizes grouped by supplier, most items first, so sizes can be requested supplier by supplier. */
export function missingBySupplier(items = []) {
    const map = new Map();
    for (const item of items) {
        const suppliers = item.suppliers?.length ? item.suppliers : ["(no supplier on PO)"];
        for (const name of suppliers) {
            let e = map.get(name);
            if (!e) {
                e = { supplier: name, itemCount: 0, openQty: 0, missingBoth: 0 };
                map.set(name, e);
            }
            e.itemCount += 1;
            e.openQty += Number(item.openQty) || 0;
            if (item.missingSize && item.missingWeight) e.missingBoth += 1;
        }
    }
    return [...map.values()].sort((a, b) => b.itemCount - a.itemCount || a.supplier.localeCompare(b.supplier));
}
