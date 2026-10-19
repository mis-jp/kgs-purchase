/**
 * Pure helpers for the Purchase Orders module (weight, PO detail link,
 * "ETD Beyond the Container" date rule). Kept framework-free so they are
 * unit-testable with node --test.
 */
import { calcStockWeightKg } from "./item-dimensions.js";

/**
 * Line weight in KG, same rule as the Stock Items "Weight" column:
 * box KG (item dimensions weight_kg) x quantity. null when the item has no KG.
 */
export function calcLineWeightKg(dim, qty) {
    return calcStockWeightKg({ weight_kg: dim?.weight_kg, qty });
}

/** Sum of line weights; null when no line has a known KG. */
export function calcOrderWeightKg(lines, lookupDim) {
    let total = null;
    for (const line of lines || []) {
        const w = calcLineWeightKg(lookupDim?.(line?.inventoryId), line?.qty);
        if (w == null) continue;
        total = (total ?? 0) + w;
    }
    return total;
}

/** Relative href of the single-PO detail page (opened in a new tab). */
export function poDetailHref(orderNbr) {
    const nbr = String(orderNbr || "").trim();
    if (!nbr) return "";
    return `/purchase-orders/${encodeURIComponent(nbr)}`;
}

/**
 * "ETD Beyond the Container" date rule.
 * A container counts when its PO ETD (Promised On) is today or later,
 * i.e. the ETD has NOT passed yet. (Reversed from the old rule, which
 * counted containers whose ETD was already in the past.)
 * Both arguments are yyyy-mm-dd keys.
 */
export function isEtdBeyondContainer(etdKey, todayKey) {
    if (!etdKey || !todayKey) return false;
    return etdKey >= todayKey;
}

/** Absolute-to-app URL of the PO detail page, including the deploy base path. */
export function poDetailUrl(orderNbr, basePath = "") {
    const href = poDetailHref(orderNbr);
    if (!href) return "";
    const base = String(basePath || "").replace(/\/+$/, "");
    return `${base}${href}`;
}

function annotationKeyMatchesOrder(key, orderNbr) {
    if (key === orderNbr) return true;
    const idx = key.indexOf("-");
    return idx > 0 && /^[A-Za-z]{1,12}$/.test(key.slice(0, idx)) && key.slice(idx + 1) === orderNbr;
}

/** Keep only one PO's annotation entries ({ refId: fields }) from the full module map. */
export function filterAnnotationsForOrder(all, orderNbr) {
    const nbr = String(orderNbr || "").trim();
    const out = {};
    if (!nbr || !all) return out;
    for (const [k, v] of Object.entries(all)) {
        if (annotationKeyMatchesOrder(String(k), nbr)) out[k] = v;
    }
    return out;
}

/** The single annotation object for a PO (bare order # preferred over typed keys). */
export function pickOrderAnnotation(all, orderNbr) {
    const scoped = filterAnnotationsForOrder(all, orderNbr);
    const nbr = String(orderNbr || "").trim();
    if (scoped[nbr]) return scoped[nbr];
    const first = Object.keys(scoped)[0];
    return first ? scoped[first] : {};
}
