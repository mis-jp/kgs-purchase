import { calcTotalCbm } from "./item-dimensions.js";
import { calcPoLineWeightKg } from "./po-metrics.js";

/** Packing list helpers: quantities, CBM / weight per line, totals and export rows. */

export const PACKING_COLUMNS = [
    "Branch",
    "Order Nbr",
    "Order Date",
    "Description",
    "Inventory ID",
    "Order Qty",
    "Qty (Manual)",
    "Total CBM",
    "Total Weight",
];

export function packingLineKey(branch, orderNbr, lineNbr, inventoryId) {
    const line = lineNbr ?? String(inventoryId || "").trim();
    return `${String(branch || "").trim().toUpperCase()}|${String(orderNbr || "").trim()}|${line}`;
}

/** Manual qty as a number, or null when blank / invalid. */
export function parseManualQty(value) {
    if (value === null || value === undefined) return null;
    const text = String(value).replace(/,/g, "").trim();
    if (!text) return null;
    const n = Number(text);
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.round(n * 10000) / 10000;
}

/** Manual qty wins when filled in; otherwise the PO order qty. */
export function packingQty(orderQty, manualQty) {
    const manual = parseManualQty(manualQty);
    if (manual !== null) return manual;
    const q = Number(orderQty);
    return Number.isFinite(q) && q > 0 ? q : 0;
}

/** CBM and weight for one line at the packing qty; null when the item has no size / KG. */
export function packingLineTotals(line, manualQty) {
    const qty = packingQty(line?.qty, manualQty);
    const dim = line?.dimensions || null;
    let cbm = dim ? calcTotalCbm({ ...dim, qty }) : null;
    if (cbm === null && qty === 0 && dim && calcTotalCbm({ ...dim, qty: 1 }) !== null) cbm = 0;
    const weightKg = dim ? calcPoLineWeightKg(dim, qty) : null;
    return {
        qty,
        cbm,
        weightKg,
        overOrdered: parseManualQty(manualQty) !== null && qty > (Number(line?.qty) || 0),
    };
}

/** Totals across lines. Lines without CBM / weight are left out and counted. */
export function packingTotals(lines, manualByKey = {}, branch = "") {
    const orders = new Set();
    let qty = 0;
    let cbm = 0;
    let weightKg = 0;
    let missingCbm = 0;
    let missingWeight = 0;
    for (const line of lines || []) {
        orders.add(String(line.orderNbr || ""));
        const t = packingLineTotals(line, manualByKey[packingLineKey(branch, line.orderNbr, line.lineNbr, line.inventoryId)]);
        qty += t.qty;
        if (t.cbm === null) missingCbm += 1; else cbm += t.cbm;
        if (t.weightKg === null) missingWeight += 1; else weightKg += t.weightKg;
    }
    return {
        orderCount: orders.size,
        lineCount: (lines || []).length,
        qty: round(qty, 4),
        cbm: round(cbm, 4),
        weightKg: round(weightKg, 2),
        missingCbm,
        missingWeight,
    };
}

/** Newest order first, then order number, then line number (matches the sample sheet). */
export function sortPackingLines(lines) {
    return [...(lines || [])].sort((a, b) => {
        const da = String(a.orderDate || "");
        const db = String(b.orderDate || "");
        if (da !== db) return db.localeCompare(da);
        const oa = String(a.orderNbr || "");
        const ob = String(b.orderNbr || "");
        if (oa !== ob) return ob.localeCompare(oa);
        return (Number(a.lineNbr) || 0) - (Number(b.lineNbr) || 0);
    });
}

/** Rows for the Excel sheet, in PACKING_COLUMNS order, with a totals row at the end. */
export function packingSheetRows(lines, manualByKey = {}, branch = "") {
    const rows = sortPackingLines(lines).map((line) => {
        const manual = manualByKey[packingLineKey(branch, line.orderNbr, line.lineNbr, line.inventoryId)];
        const t = packingLineTotals(line, manual);
        return [
            branch,
            line.orderNbr,
            toDate(line.orderDate),
            line.description || "",
            line.inventoryId || "",
            Number(line.qty) || 0,
            t.qty,
            t.cbm === null ? null : round(t.cbm, 4),
            t.weightKg === null ? null : round(t.weightKg, 2),
        ];
    });
    const totals = packingTotals(lines, manualByKey, branch);
    rows.push(["Total", `${totals.orderCount} PO(s)`, null, `${totals.lineCount} line(s)`, null, null, totals.qty, totals.cbm, totals.weightKg]);
    return rows;
}

/** Practical loading limits (not internal volume): boxes never fill a container to the wall. */
export const CONTAINER_TYPES = [
    { id: "20ft", label: "20ft Standard", usableCbm: 28, maxKg: 21000 },
    { id: "40ft", label: "40ft Standard", usableCbm: 58, maxKg: 26000 },
    { id: "40hc", label: "40ft High Cube", usableCbm: 68, maxKg: 26000 },
];

/** For each container type: how many are needed and how full they are by volume and weight. */
export function containerOptions(cbm, weightKg) {
    const volume = Math.max(0, Number(cbm) || 0);
    const weight = Math.max(0, Number(weightKg) || 0);
    if (!volume && !weight) return [];
    return CONTAINER_TYPES.map((c) => {
        const count = Math.max(1, Math.ceil(volume / c.usableCbm), Math.ceil(weight / c.maxKg));
        return {
            id: c.id,
            label: c.label,
            count,
            cbmFillPct: round((volume / (count * c.usableCbm)) * 100, 1),
            weightFillPct: round((weight / (count * c.maxKg)) * 100, 1),
            limitedBy: Math.ceil(weight / c.maxKg) > Math.ceil(volume / c.usableCbm) ? "weight" : "volume",
        };
    });
}

/** Fewest containers: fill 40ft High Cubes, then the smallest type that takes what is left. */
export function recommendContainerMix(cbm, weightKg) {
    let volume = Math.max(0, Number(cbm) || 0);
    let weight = Math.max(0, Number(weightKg) || 0);
    if (!volume && !weight) return [];
    const largest = CONTAINER_TYPES[CONTAINER_TYPES.length - 1];
    const counts = new Map();
    const add = (c) => counts.set(c.id, (counts.get(c.id) || 0) + 1);
    while (volume > largest.usableCbm || weight > largest.maxKg) {
        add(largest);
        volume = Math.max(0, volume - largest.usableCbm);
        weight = Math.max(0, weight - largest.maxKg);
    }
    add(CONTAINER_TYPES.find((c) => volume <= c.usableCbm && weight <= c.maxKg) || largest);
    return CONTAINER_TYPES.filter((c) => counts.has(c.id))
        .reverse()
        .map((c) => ({ id: c.id, label: c.label, count: counts.get(c.id) }));
}

export function containerMixText(mix) {
    return (mix || []).map((m) => `${m.count} × ${m.label}`).join(" + ");
}

function toDate(value) {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
}

function round(n, digits) {
    const f = 10 ** digits;
    return Math.round(n * f) / f;
}
