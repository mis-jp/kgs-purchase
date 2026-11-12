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
    "Freight / Total CBM",
    "Freight/Pc",
];

/** Trucking fee spread per CBM; null when there is no fee or no measured CBM to spread it over. */
export function freightRatePerCbm(truckingFee, totalCbm) {
    const fee = parseManualQty(truckingFee);
    const cbm = Number(totalCbm);
    if (fee === null || !Number.isFinite(cbm) || cbm <= 0) return null;
    return fee / cbm;
}

/** A line's share of the trucking fee (by its CBM) and that share per piece. */
export function packingLineFreight(lineTotals, ratePerCbm) {
    if (ratePerCbm === null || ratePerCbm === undefined || lineTotals?.cbm === null || lineTotals?.cbm === undefined) {
        return { freight: null, freightPerPc: null };
    }
    const freight = lineTotals.cbm * ratePerCbm;
    return {
        freight,
        freightPerPc: lineTotals.qty > 0 ? freight / lineTotals.qty : null,
    };
}

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
export function packingSheetRows(lines, manualByKey = {}, branch = "", truckingFee = null) {
    const totals = packingTotals(lines, manualByKey, branch);
    const rate = freightRatePerCbm(truckingFee, totals.cbm);
    let freightTotal = null;
    const rows = sortPackingLines(lines).map((line) => {
        const manual = manualByKey[packingLineKey(branch, line.orderNbr, line.lineNbr, line.inventoryId)];
        const t = packingLineTotals(line, manual);
        const f = packingLineFreight(t, rate);
        if (f.freight !== null) freightTotal = (freightTotal || 0) + f.freight;
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
            f.freight === null ? null : round(f.freight, 2),
            f.freightPerPc === null ? null : round(f.freightPerPc, 2),
        ];
    });
    rows.push([
        "Total",
        `${totals.orderCount} PO(s)`,
        null,
        `${totals.lineCount} line(s)`,
        null,
        null,
        totals.qty,
        totals.cbm,
        totals.weightKg,
        freightTotal === null ? null : round(freightTotal, 2),
        null,
    ]);
    return rows;
}

/** Practical loading limits (not internal volume): boxes never fill a container to the wall. */
export const CONTAINER_TYPES = [
    { id: "20ft", label: "20ft Standard", usableCbm: 28, maxKg: 21000 },
    { id: "40ft", label: "40ft Standard", usableCbm: 58, maxKg: 26000 },
    { id: "40hc", label: "40ft High Cube", usableCbm: 68, maxKg: 26000 },
];

export const CONTAINER_LIMIT_RANGE = { minCbm: 1, maxCbm: 200, minKg: 100, maxKg: 100000 };
export const CUSTOM_CONTAINER_ID = "custom";
const CUSTOM_LABEL_MAX = 40;
const MIX_SEARCH_LIMIT = 300000;

/** Whole containers needed; ignores floating-point dust such as 56.0000000001 / 28. */
function ceilDiv(amount, capacity) {
    return Math.ceil(round(amount / capacity, 9));
}

function validLimit(value, min, max) {
    const n = parseManualQty(value);
    return n !== null && n >= min && n <= max ? n : null;
}

/** Why a limit the user typed is rejected, or "" when it is fine (blank means "use the standard value"). */
export function containerLimitError(value, kind) {
    if (String(value ?? "").trim() === "") return "";
    const { minCbm, maxCbm, minKg, maxKg } = CONTAINER_LIMIT_RANGE;
    const [min, max, unit] = kind === "kg" ? [minKg, maxKg, "kg"] : [minCbm, maxCbm, "m³"];
    return validLimit(value, min, max) === null ? `Enter ${min.toLocaleString()}–${max.toLocaleString()} ${unit}` : "";
}

/**
 * Container types to plan with. `overrides` holds what the user typed:
 * { "20ft": { cbm, kg }, …, custom: { enabled, label, cbm, kg } }.
 * Blank or invalid values keep the standard limit; the custom container is added only when complete.
 */
export function resolveContainerTypes(overrides = {}) {
    const { minCbm, maxCbm, minKg, maxKg } = CONTAINER_LIMIT_RANGE;
    const types = CONTAINER_TYPES.map((c) => {
        const o = overrides?.[c.id] || {};
        return {
            ...c,
            usableCbm: validLimit(o.cbm, minCbm, maxCbm) ?? c.usableCbm,
            maxKg: validLimit(o.kg, minKg, maxKg) ?? c.maxKg,
        };
    });
    const custom = overrides?.[CUSTOM_CONTAINER_ID];
    if (custom?.enabled) {
        const usableCbm = validLimit(custom.cbm, minCbm, maxCbm);
        const kg = validLimit(custom.kg, minKg, maxKg);
        const label = String(custom.label || "").trim().slice(0, CUSTOM_LABEL_MAX) || "Custom container";
        if (usableCbm !== null && kg !== null) {
            types.push({ id: CUSTOM_CONTAINER_ID, label, usableCbm, maxKg: kg });
        }
    }
    return types;
}

export const CONTAINER_LIMITS_STORAGE_KEY = "pl_container_limits_v1";
export const CONTAINER_LIMITS_EVENT = "pl-container-limits-changed";

/** What the user typed last time on this computer; {} when nothing is saved. */
export function loadContainerLimits() {
    if (typeof window === "undefined") return {};
    try {
        const parsed = JSON.parse(window.localStorage.getItem(CONTAINER_LIMITS_STORAGE_KEY) || "{}");
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

export function saveContainerLimits(limits) {
    if (typeof window === "undefined") return;
    try {
        window.localStorage.setItem(CONTAINER_LIMITS_STORAGE_KEY, JSON.stringify(limits || {}));
    } catch { /* storage full or blocked: limits still apply for this visit */ }
    window.dispatchEvent(new Event(CONTAINER_LIMITS_EVENT));
}

export function containerTypesChanged(types) {
    return types.length !== CONTAINER_TYPES.length || types.some((t, i) => {
        const std = CONTAINER_TYPES[i];
        return t.usableCbm !== std.usableCbm || t.maxKg !== std.maxKg;
    });
}

export function containerLimitsText(types = CONTAINER_TYPES) {
    return types
        .map((t) => `${t.label} ${t.usableCbm.toLocaleString()} m³ / ${t.maxKg.toLocaleString()} kg`)
        .join(", ");
}

/** For each container type: how many are needed and how full they are by volume and weight. */
export function containerOptions(cbm, weightKg, types = CONTAINER_TYPES) {
    const volume = Math.max(0, Number(cbm) || 0);
    const weight = Math.max(0, Number(weightKg) || 0);
    if (!volume && !weight) return [];
    return types.map((c) => {
        const byVolume = ceilDiv(volume, c.usableCbm);
        const byWeight = ceilDiv(weight, c.maxKg);
        const count = Math.max(1, byVolume, byWeight);
        return {
            id: c.id,
            label: c.label,
            usableCbm: c.usableCbm,
            maxKg: c.maxKg,
            count,
            cbmFillPct: round((volume / (count * c.usableCbm)) * 100, 1),
            weightFillPct: round((weight / (count * c.maxKg)) * 100, 1),
            limitedBy: byWeight > byVolume ? "weight" : "volume",
        };
    });
}

const bySize = (a, b) => a.usableCbm - b.usableCbm || a.maxKg - b.maxKg;

/** Fill the largest container, then the smallest type that takes what is left. */
function greedyMix(volume, weight, types) {
    const sorted = [...types].sort(bySize);
    const largest = sorted[sorted.length - 1];
    const counts = new Map();
    const add = (c) => counts.set(c.id, (counts.get(c.id) || 0) + 1);
    while (volume > largest.usableCbm || weight > largest.maxKg) {
        add(largest);
        volume = Math.max(0, volume - largest.usableCbm);
        weight = Math.max(0, weight - largest.maxKg);
    }
    add(sorted.find((c) => volume <= c.usableCbm && weight <= c.maxKg) || largest);
    return counts;
}

/** Every combination of the other types, the last type covering the rest: fewest containers, then least spare room. */
function exhaustiveMix(volume, weight, types) {
    const caps = types.map((c) => Math.max(ceilDiv(volume, c.usableCbm), ceilDiv(weight, c.maxKg)));
    const combos = caps.slice(0, -1).reduce((n, cap) => n * (cap + 1), 1);
    if (combos > MIX_SEARCH_LIMIT) return null;

    const last = types[types.length - 1];
    let best = null;
    const counts = new Array(types.length).fill(0);
    const visit = (i, vol, kg) => {
        if (i === types.length - 1) {
            const need = Math.max(0, ceilDiv(vol, last.usableCbm), ceilDiv(kg, last.maxKg));
            counts[i] = need;
            const total = counts.reduce((s, n) => s + n, 0);
            if (!total) return;
            const capCbm = counts.reduce((s, n, k) => s + n * types[k].usableCbm, 0);
            const capKg = counts.reduce((s, n, k) => s + n * types[k].maxKg, 0);
            if (!best || total < best.total || (total === best.total && (capCbm < best.capCbm || (capCbm === best.capCbm && capKg < best.capKg)))) {
                best = { total, capCbm, capKg, counts: [...counts] };
            }
            return;
        }
        for (let n = 0; n <= caps[i]; n++) {
            counts[i] = n;
            visit(i + 1, vol - n * types[i].usableCbm, kg - n * types[i].maxKg);
        }
    };
    visit(0, volume, weight);
    if (!best) return null;
    return new Map(types.map((t, k) => [t.id, best.counts[k]]).filter(([, n]) => n > 0));
}

/**
 * Fewest containers that hold the whole volume and weight. Keeps the familiar "largest first" mix
 * when it is already the minimum; custom limits can make another mix smaller.
 */
export function recommendContainerMix(cbm, weightKg, types = CONTAINER_TYPES) {
    const volume = Math.max(0, Number(cbm) || 0);
    const weight = Math.max(0, Number(weightKg) || 0);
    if ((!volume && !weight) || !types.length) return [];
    const total = (m) => [...m.values()].reduce((s, n) => s + n, 0);
    let counts = greedyMix(volume, weight, types);
    const exact = exhaustiveMix(volume, weight, types);
    if (exact && total(exact) < total(counts)) counts = exact;
    return [...types].sort(bySize).reverse()
        .filter((c) => counts.has(c.id))
        .map((c) => ({ id: c.id, label: c.label, count: counts.get(c.id) }));
}

export function containerMixText(mix) {
    return (mix || []).map((m) => `${m.count} × ${m.label}`).join(" + ");
}

/** Recommended mix plus how full it is overall, by volume and by weight. Null when there is nothing to load. */
export function containerFillSummary(cbm, weightKg, types = CONTAINER_TYPES) {
    const mix = recommendContainerMix(cbm, weightKg, types);
    if (!mix.length) return null;
    let capCbm = 0;
    let capKg = 0;
    for (const m of mix) {
        const type = types.find((c) => c.id === m.id);
        capCbm += type.usableCbm * m.count;
        capKg += type.maxKg * m.count;
    }
    const volumePct = round(((Number(cbm) || 0) / capCbm) * 100, 1);
    const weightPct = round(((Number(weightKg) || 0) / capKg) * 100, 1);
    return { mix, text: containerMixText(mix), volumePct, weightPct, fillPct: Math.max(volumePct, weightPct) };
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
