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
